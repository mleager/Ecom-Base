package checkout

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/httpjson"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const guestRecoveryBase = "ecom_guest_recovery"

type GuestHandler struct {
	service                             *GuestService
	boundary                            *commerce.GuestHandler
	secure                              bool
	prepareLimit, mailLimit, proofLimit *auth.RequestLimiter
}

func NewGuestHandler(service *GuestService, boundary *commerce.GuestHandler, secure bool) *GuestHandler {
	return &GuestHandler{
		service: service, boundary: boundary, secure: secure,
		prepareLimit: auth.NewRequestLimiter("guest_checkout_prepare", 5, time.Hour, service.recorder(), boundary.SharedLimits()),
		mailLimit:    auth.NewRequestLimiter("guest_checkout_mail", 3, time.Hour, service.recorder(), boundary.SharedLimits()),
		proofLimit:   auth.NewRequestLimiter("guest_checkout_proof", 5, time.Minute, service.recorder(), boundary.SharedLimits()),
	}
}

func (h *GuestHandler) Routes(api chi.Router) {
	api.Group(func(r chi.Router) {
		r.Use(h.boundary.CheckoutAdmission)
		r.Post("/guest/checkout-intents", h.prepare)
		r.Get("/guest/checkout-intents/{id}", h.intent)
		r.Post("/guest/checkout-intents/{id}/retire", h.retire)
		r.Post("/guest/checkout", h.checkout)
		r.Get("/guest/orders", h.orders)
		r.Get("/guest/orders/{id}", h.order)
		r.Get("/guest/orders/{id}/payments", h.payments)
		r.Post("/guest/orders/{id}/cancel", h.cancel)
		r.Post("/guest/recovery-requests", h.requestRecovery)
		r.Post("/guest/recovery-confirmations", h.confirmRecovery)
		r.Get("/guest/recovery-access", h.recovery)
		r.Delete("/guest/recovery-access", h.endRecovery)
	})
}

func guestError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, commerce.ErrGuestSession):
		httpjson.Error(w, 401, "guest_session_unavailable", "Guest session is unavailable")
	case errors.Is(err, errGuestRecovery):
		httpjson.Error(w, 401, "guest_recovery_unavailable", "Guest recovery access is unavailable")
	case errors.Is(err, ErrInvalidKey):
		httpjson.Error(w, 400, "invalid_idempotency_key", "Exactly one canonical UUIDv4 Idempotency-Key is required")
	case errors.Is(err, errGuestIntentNotFound):
		httpjson.Error(w, 404, "checkout_intent_not_found", "Checkout intent not found")
	case errors.Is(err, errGuestIntentExpired):
		httpjson.Error(w, 409, "checkout_intent_expired", "Checkout preparation expired")
	case errors.Is(err, errGuestIntentRetired):
		httpjson.Error(w, 409, "checkout_intent_retired", "Checkout intent was retired")
	case errors.Is(err, errGuestIntentRejected):
		httpjson.Error(w, 409, "checkout_intent_rejected", "Checkout intent was rejected")
	case errors.Is(err, errGuestIntentCapacity):
		httpjson.Error(w, 409, "guest_capacity_exhausted", "Guest intent capacity is exhausted")
	case errors.Is(err, commerce.ErrGuestCheckout):
		httpjson.Error(w, 409, "guest_checkout_unresolved", "Resolve the existing guest checkout first")
	case errors.Is(err, errGuestProof):
		httpjson.Error(w, 400, "invalid_guest_proof", "Recovery link is invalid or no longer available")
	case errors.Is(err, ErrOutcomeUncertain):
		httpjson.Error(w, 503, "guest_outcome_unknown", "Read current state before another deliberate action")
	default:
		respondError(w, err)
	}
}

func cookieDigest(r *http.Request, name string, invalid error, allowMalformed bool) ([]byte, error) {
	raw, _, err := commerce.ReadGuestCookie(r, name)
	if err != nil {
		if allowMalformed && errors.Is(err, commerce.ErrGuestSession) {
			return nil, nil
		}
		return nil, invalid
	}

	hash, _ := commerce.GuestTokenDigest(raw)
	return hash, nil
}

func (h *GuestHandler) access(w http.ResponseWriter, r *http.Request, target guestTarget, fullOnly bool) (guestAccess, bool) {
	full, err := cookieDigest(r, commerce.GuestCookieName(h.secure), commerce.ErrGuestSession, !fullOnly)
	if err != nil {
		guestError(w, err)
		return guestAccess{}, false
	}

	var grant []byte
	if !fullOnly {
		grant, err = cookieDigest(r, h.recoveryCookie(), errGuestRecovery, true)
		if err != nil {
			guestError(w, err)
			return guestAccess{}, false
		}
	}

	access, err := h.service.authorize(r.Context(), full, grant, target, fullOnly)
	if err != nil {
		guestError(w, err)
		return guestAccess{}, false
	}

	if r.Method != http.MethodGet && !h.boundary.AllowGuestWrite(w, r, access.owner.String()) {
		return guestAccess{}, false
	}

	return access, true
}

func guestHeaderKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		guestError(w, ErrInvalidKey)
		return "", false
	}

	if _, err := parseV4(keys[0]); err != nil {
		guestError(w, ErrInvalidKey)
		return "", false
	}

	return keys[0], true
}

func (h *GuestHandler) prepare(w http.ResponseWriter, r *http.Request) {
	key, ok := guestHeaderKey(w, r)
	if !ok {
		return
	}

	var input guestPreparation
	fields := []string{"id", "cart_version", "payment_scenario", "contact_email", "shipping_address"}
	if !httpjson.Decode(w, r, &input, fields, fields) {
		return
	}

	var shipping ShippingAddress
	required := []string{"recipient_name", "line_1", "city", "region", "postal_code", "country_code"}
	if !httpjson.DecodeObject(w, input.Shipping, &shipping, append(required, "line_2"), required) {
		return
	}

	request, err := guestRequest(pgtype.UUID{}, key, GuestReference{input.ID, input.CartVersion, input.PaymentScenario})
	if err != nil {
		guestError(w, err)
		return
	}

	access, ok := h.access(w, r, guestTarget{}, true)
	if !ok {
		return
	}

	if retry, capacity := h.prepareLimit.Check(r.Context(), access.owner.String(), time.Now()); retry != 0 {
		commerce.WriteGuestLimit(w, retry, capacity)
		return
	}

	request.guest = access.owner
	view, created, err := h.service.prepare(r.Context(), access, request, shipping, input.ContactEmail)
	if err != nil {
		guestError(w, err)
		return
	}

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}

	httpjson.Write(w, status, view)
}

func (h *GuestHandler) intent(w http.ResponseWriter, r *http.Request) {
	id, err := parseV4(chi.URLParam(r, "id"))
	if err != nil {
		guestError(w, err)
		return
	}

	access, ok := h.access(w, r, guestTarget{intent: id}, false)
	if !ok {
		return
	}

	view, err := h.service.getIntent(r.Context(), access, id)
	if err != nil {
		guestError(w, err)
		return
	}

	httpjson.Write(w, 200, view)
}

func (h *GuestHandler) retire(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	key, ok := guestHeaderKey(w, r)
	if !ok {
		return
	}

	id, err := parseV4(chi.URLParam(r, "id"))
	if err != nil {
		guestError(w, err)
		return
	}

	access, ok := h.access(w, r, guestTarget{intent: id}, false)
	if !ok {
		return
	}

	result, err := h.service.retire(r.Context(), access, validatedRequest{guest: access.owner, guestIntent: id, key: key})
	if err != nil {
		guestError(w, err)
		return
	}

	httpjson.Write(w, 200, result)
}

func (h *GuestHandler) checkout(w http.ResponseWriter, r *http.Request) {
	key, ok := guestHeaderKey(w, r)
	if !ok {
		return
	}

	var ref GuestReference
	fields := []string{"checkout_intent_id", "cart_version", "payment_scenario"}
	if !httpjson.Decode(w, r, &ref, fields, fields) {
		return
	}

	request, err := guestRequest(pgtype.UUID{}, key, ref)
	if err != nil {
		guestError(w, err)
		return
	}

	access, ok := h.access(w, r, guestTarget{intent: request.guestIntent}, false)
	if !ok {
		return
	}

	request.guest = access.owner
	result, err := h.service.submit(r.Context(), access, request)
	if errors.Is(err, ErrOutcomeUncertain) {
		respondError(w, err)
		return
	}
	if err != nil {
		guestError(w, err)
		return
	}

	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	} else if result.Interrupted {
		status = http.StatusAccepted
	}

	httpjson.Write(w, status, result.Order)
}

func (h *GuestHandler) orders(w http.ResponseWriter, r *http.Request) {
	limit, offset, err := httpjson.Pagination(r.URL.RawQuery)
	if err != nil {
		guestError(w, err)
		return
	}

	access, ok := h.access(w, r, guestTarget{}, true)
	if !ok {
		return
	}

	orders, err := h.service.listOrders(r.Context(), access, limit, offset)
	if err != nil {
		guestError(w, err)
		return
	}

	httpjson.Write(w, 200, orders)
}

func (h *GuestHandler) orderAccess(w http.ResponseWriter, r *http.Request) (pgtype.UUID, guestAccess, bool) {
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		guestError(w, err)
		return id, guestAccess{}, false
	}

	access, ok := h.access(w, r, guestTarget{order: id}, false)
	return id, access, ok
}

func (h *GuestHandler) order(w http.ResponseWriter, r *http.Request) {
	h.readOrder(w, r, false)
}

func (h *GuestHandler) payments(w http.ResponseWriter, r *http.Request) {
	h.readOrder(w, r, true)
}

func (h *GuestHandler) readOrder(w http.ResponseWriter, r *http.Request, paymentsOnly bool) {
	id, access, ok := h.orderAccess(w, r)
	if !ok {
		return
	}

	order, err := h.service.order(r.Context(), access, id)
	if err != nil {
		guestError(w, err)
		return
	}

	if paymentsOnly {
		httpjson.Write(w, 200, []Payment{order.Payment})
		return
	}

	httpjson.Write(w, 200, order)
}

func (h *GuestHandler) cancel(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	id, access, ok := h.orderAccess(w, r)
	if !ok {
		return
	}

	order, err := h.service.cancelOrder(r.Context(), access, id)
	if err != nil {
		guestError(w, err)
		return
	}

	httpjson.Write(w, 200, order)
}

func (h *GuestHandler) requestRecovery(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Contact string  `json:"contact_email"`
		Intent  *string `json:"checkout_intent_id"`
		Order   *string `json:"order_id"`
	}

	if !httpjson.Decode(w, r, &input, []string{"contact_email", "checkout_intent_id", "order_id"}, []string{"contact_email"}) {
		return
	}

	contact, valid := auth.NormalizeContactEmail(input.Contact)
	if !valid || (input.Intent == nil) == (input.Order == nil) {
		guestError(w, ErrInvalidInput)
		return
	}

	var target guestTarget
	var err error
	var scope, reference string
	if input.Intent != nil {
		target.intent, err = parseV4(*input.Intent)
		scope, reference = "intent", target.intent.String()
	} else {
		target.order, err = parseID(*input.Order)
		scope, reference = "order", target.order.String()
	}
	if err != nil {
		guestError(w, err)
		return
	}

	if !h.service.deliveryEnabled() {
		httpjson.Error(w, 503, "email_delivery_unavailable", "Email delivery is unavailable")
		return
	}

	floor := time.NewTimer(8 * time.Second)
	defer floor.Stop()

	limitKey := sha256.Sum256([]byte(scope + ":" + reference + ":" + contact))
	if retry, _ := h.mailLimit.Check(r.Context(), hex.EncodeToString(limitKey[:]), time.Now()); retry == 0 {
		lookup, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		token, err := h.service.issueGuestProof(lookup, target, contact)
		cancel()
		if err == nil && token != "" {
			h.service.sendGuestProof(r.Context(), contact, token)
		}
	}

	select {
	case <-r.Context().Done():
		return
	case <-floor.C:
		httpjson.Write(w, 202, struct {
			Message string `json:"message"`
		}{"If the reference and email are eligible, recovery instructions will be sent."})
	}
}

func (h *GuestHandler) confirmRecovery(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if !httpjson.Decode(w, r, &input, []string{"token"}, []string{"token"}) {
		return
	}

	digest, err := commerce.GuestTokenDigest(input.Token)
	if err != nil {
		guestError(w, errGuestProof)
		return
	}

	if retry, capacity := h.proofLimit.Check(r.Context(), hex.EncodeToString(digest), time.Now()); retry != 0 {
		commerce.WriteGuestLimit(w, retry, capacity)
		return
	}

	previous, err := cookieDigest(r, h.recoveryCookie(), errGuestRecovery, false)
	if err != nil {
		guestError(w, err)
		return
	}

	view, token, err := h.service.confirmGuestProof(r.Context(), digest, previous)
	if err != nil {
		guestError(w, err)
		return
	}

	h.setRecoveryCookie(w, token, view.ExpiresAt, 0)
	httpjson.Write(w, 200, view)
}

func (h *GuestHandler) recovery(w http.ResponseWriter, r *http.Request) {
	digest, err := cookieDigest(r, h.recoveryCookie(), errGuestRecovery, false)
	if err != nil {
		guestError(w, err)
		return
	}

	view, err := h.service.getRecovery(r.Context(), digest)
	if err != nil {
		guestError(w, err)
		return
	}

	httpjson.Write(w, 200, view)
}

func (h *GuestHandler) endRecovery(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	digest, err := cookieDigest(r, h.recoveryCookie(), errGuestRecovery, false)
	if err == nil {
		err = h.service.endRecovery(r.Context(), digest)
	}
	if err != nil {
		guestError(w, err)
		return
	}

	h.setRecoveryCookie(w, "", time.Unix(1, 0).UTC(), -1)
	w.WriteHeader(http.StatusNoContent)
}

func (h *GuestHandler) recoveryCookie() string {
	return auth.CookieName(guestRecoveryBase, h.secure)
}

func (h *GuestHandler) setRecoveryCookie(w http.ResponseWriter, raw string, deadline time.Time, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: h.recoveryCookie(), Value: raw, Path: "/api/v1/guest", HttpOnly: true,
		Secure: h.secure, SameSite: http.SameSiteStrictMode, Expires: deadline, MaxAge: maxAge,
	})
}
