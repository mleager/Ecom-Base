package commerce

import (
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/httpjson"

	"github.com/go-chi/chi/v5"
)

const guestCookieName = "ecom_guest"

var ErrDuplicateGuestCookie = errors.New("duplicate guest cookie")

type GuestHandler struct {
	service                                     *Service
	authenticate                                func(http.Handler) http.Handler
	options                                     auth.HTTPOptions
	bootstrap, reads, writes, owners, rotations *auth.RequestLimiter
	mailRequests, mailConfirmations             *auth.RequestLimiter
	slots                                       chan struct{}
}

func NewGuestHandler(service *Service, authenticate func(http.Handler) http.Handler, options auth.HTTPOptions) *GuestHandler {
	return &GuestHandler{
		service: service, authenticate: authenticate, options: options,
		bootstrap: auth.NewRequestLimiter(5, time.Hour), reads: auth.NewRequestLimiter(120, time.Minute),
		writes: auth.NewRequestLimiter(30, time.Minute), owners: auth.NewRequestLimiter(30, time.Minute),
		rotations: auth.NewRequestLimiter(5, time.Hour), slots: make(chan struct{}, 32),
		mailRequests: auth.NewRequestLimiter(20, time.Minute), mailConfirmations: auth.NewRequestLimiter(20, time.Minute),
	}
}

func (h *GuestHandler) Routes(api chi.Router) {
	api.Group(func(r chi.Router) {
		r.Use(h.admit)
		r.Get("/guest/session", h.session)
		r.Post("/guest/session", h.create)
		r.Delete("/guest/session", h.end)
		r.Post("/guest/session/rotate", h.rotate)
		r.Get("/guest/cart", h.cart)
		r.Post("/guest/cart/items", h.add)
		r.Patch("/guest/cart/items/{id}", h.replace)
		r.Delete("/guest/cart/items/{id}", h.remove)
		r.Delete("/guest/cart/items", h.clear)
		r.With(h.authenticate).Get("/guest/cart-choice", h.choice)
		r.With(h.authenticate).Post("/guest/cart-choice", h.choose)
	})
}

func readGuestCookie(r *http.Request) (string, bool, error) {
	return ReadGuestCookie(r, guestCookieName)
}

// ReadGuestCookie distinguishes absent credentials from malformed or duplicate cookies.
func ReadGuestCookie(r *http.Request, cookieName string) (string, bool, error) {
	// net/http omits malformed cookie values. A supplied malformed credential
	// must not be mistaken for a missing cookie and silently bootstrap a new owner.
	supplied := 0
	for _, header := range r.Header.Values("Cookie") {
		for _, part := range strings.Split(header, ";") {
			name, _, _ := strings.Cut(strings.TrimSpace(part), "=")
			if strings.TrimSpace(name) == cookieName {
				supplied++
			}
		}
	}

	cookies := r.CookiesNamed(cookieName)
	if supplied > 1 {
		return "", true, ErrDuplicateGuestCookie
	}
	if supplied != len(cookies) {
		return "", true, ErrGuestSession
	}

	if len(cookies) == 0 {
		return "", false, nil
	}

	return cookies[0].Value, true, nil
}

func (h *GuestHandler) allow(w http.ResponseWriter, limiter *auth.RequestLimiter, key string) bool {
	retry, capacity := limiter.Check(key, time.Now())
	if retry == 0 {
		return true
	}
	WriteGuestLimit(w, retry, capacity)
	return false
}

// WriteGuestLimit uses the same admission response for all guest writes.
func WriteGuestLimit(w http.ResponseWriter, retry time.Duration, capacity bool) {
	seconds := max(1, min(3600, int(math.Ceil(retry.Seconds()))))
	w.Header().Set("Retry-After", strconv.Itoa(seconds))

	if capacity {
		httpjson.Error(w, 503, "guest_capacity_unavailable", "Guest admission capacity is unavailable; retry later")
	} else {
		httpjson.Error(w, 429, "rate_limited", "Too many guest requests; retry later")
	}

}

func (h *GuestHandler) admit(next http.Handler) http.Handler {
	return h.admission(next, false)
}

// CheckoutAdmission shares the guest boundary and global write slots with carts.
func (h *GuestHandler) CheckoutAdmission(next http.Handler) http.Handler {
	return h.admission(next, true)
}

func (h *GuestHandler) AllowGuestWrite(w http.ResponseWriter, guestID string) bool {
	return h.allow(w, h.owners, guestID)
}

func (h *GuestHandler) admission(next http.Handler, checkout bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if len(r.Header.Values("Origin")) > 1 || len(r.Header.Values("Origin")) == 1 && r.Header.Get("Origin") != h.options.Origin {
			httpjson.Error(w, 403, "origin_rejected", "Origin is not allowed")
			return
		}

		choice := r.URL.Path == "/api/v1/guest/cart-choice"
		if !choice && len(r.Header.Values("Authorization")) != 0 {
			httpjson.Error(w, 400, "invalid_guest_authentication", "This operation does not accept a bearer credential")
			return
		}

		write := r.Method != http.MethodGet
		if write && (len(r.Header.Values("Origin")) != 1 || r.Header.Get("Origin") != h.options.Origin || len(r.Header.Values("X-CSRF-Protection")) != 1 || r.Header.Get("X-CSRF-Protection") != "1") {
			httpjson.Error(w, 403, "csrf_rejected", "Origin and CSRF protection are required")
			return
		}

		if r.URL.RawQuery != "" && !(checkout && r.Method == http.MethodGet && r.URL.Path == "/api/v1/guest/orders") {
			httpjson.Error(w, 400, "bad_request", "Query parameters are not supported")
			return
		}

		host, _, err := net.SplitHostPort(r.RemoteAddr)
		peer := net.ParseIP(host)
		if err != nil || peer == nil {
			httpjson.Error(w, 400, "invalid_peer", "Invalid peer address")
			return
		}

		limits := h.reads
		if write {
			limits = h.writes
		}

		if !h.allow(w, limits, peer.String()) {
			return
		}
		budget := 5 * time.Second
		if checkout {
			switch r.URL.Path {
			case "/api/v1/guest/checkout":
				budget = 14 * time.Second
			case "/api/v1/guest/recovery-requests":
				if !h.allow(w, h.mailRequests, peer.String()) {
					return
				}
				budget = 10 * time.Second
			case "/api/v1/guest/recovery-confirmations":
				if !h.allow(w, h.mailConfirmations, peer.String()) {
					return
				}
			}
		}

		if write {
			select {
			case h.slots <- struct{}{}:
				defer func() { <-h.slots }()
			default:
				w.Header().Set("Retry-After", "5")
				httpjson.Error(w, 503, "guest_capacity_unavailable", "Guest write capacity is unavailable")
				return
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), budget)
		defer cancel()

		if checkout && !write && !httpjson.Bodyless(w, r) {
			return
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func guestRespond(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrGuestSession), errors.Is(err, ErrDuplicateGuestCookie):
		httpjson.Error(w, 401, "guest_session_unavailable", "Guest session is unavailable; verify or end it explicitly")
	case errors.Is(err, ErrAccountSession):
		httpjson.Error(w, 401, "unauthorized", "Account session is unavailable")
	case errors.Is(err, ErrGuestCapacity):
		w.Header().Set("Retry-After", "5")
		httpjson.Error(w, 503, "guest_capacity_unavailable", "Guest session capacity is unavailable")
	case errors.Is(err, ErrCartChoice):
		httpjson.Error(w, 409, "cart_choice_conflict", "Cart versions changed; review both carts")
	case errors.Is(err, ErrGuestCheckout):
		httpjson.Error(w, 409, "guest_checkout_unresolved", "Resolve the original guest checkout before adopting this cart")
	case errors.Is(err, ErrInvalidInput), errors.Is(err, ErrMalformedID), errors.Is(err, ErrNotFound), errors.Is(err, ErrCartFull), errors.Is(err, ErrVersionExhausted):
		respondError(w, err)
	default:
		httpjson.Error(w, 503, "guest_outcome_unknown", "Request outcome is unavailable; read current state before another deliberate action")
	}
}

func (h *GuestHandler) cookie(w http.ResponseWriter, raw string, deadline time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     guestCookieName,
		Value:    raw,
		Path:     "/api/v1/guest",
		HttpOnly: true,
		Secure:   h.options.SecureCookies,
		SameSite: http.SameSiteStrictMode,
		Expires:  deadline,
	})
}

func (h *GuestHandler) credential(w http.ResponseWriter, r *http.Request) (string, GuestSession, bool) {
	raw, present, err := readGuestCookie(r)
	if err != nil || !present {
		guestRespond(w, ErrGuestSession)
		return "", GuestSession{}, false
	}

	view, err := h.service.GetGuestSession(r.Context(), raw)
	if err != nil {
		guestRespond(w, err)
		return "", GuestSession{}, false
	}

	if r.Method != http.MethodGet && !h.allow(w, h.owners, view.GuestID) {
		return "", GuestSession{}, false
	}

	return raw, view, true
}

func (h *GuestHandler) session(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	_, view, ok := h.credential(w, r)
	if ok {
		httpjson.Write(w, 200, view)
	}
}

func (h *GuestHandler) create(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	_, present, err := readGuestCookie(r)
	if err != nil {
		guestRespond(w, err)
		return
	}

	if present {
		_, view, ok := h.credential(w, r)
		if ok {
			httpjson.Write(w, 200, view)
		}
		return
	}

	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !h.allow(w, h.bootstrap, net.ParseIP(host).String()) {
		return
	}

	view, raw, err := h.service.CreateGuestSession(r.Context())
	if err != nil {
		guestRespond(w, err)
		return
	}

	h.cookie(w, raw, view.ExpiresAt)
	httpjson.Write(w, 201, view)
}

func (h *GuestHandler) rotate(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	raw, view, ok := h.credential(w, r)
	if !ok || !h.allow(w, h.rotations, view.GuestID) {
		return
	}

	view, next, err := h.service.RotateGuestSession(r.Context(), raw)
	if err != nil {
		guestRespond(w, err)
		return
	}

	h.cookie(w, next, view.ExpiresAt)
	httpjson.Write(w, 200, view)
}

func (h *GuestHandler) end(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	raw, _, err := readGuestCookie(r)
	if err != nil {
		guestRespond(w, err)
		return
	}

	// End also works with a missing, malformed or expired single credential.
	// Apply the owner budget when an owner can still be verified.
	if view, err := h.service.GetGuestSession(r.Context(), raw); err == nil {
		if !h.allow(w, h.owners, view.GuestID) {
			return
		}
	} else if !errors.Is(err, ErrGuestSession) {
		guestRespond(w, err)
		return
	}

	if err := h.service.EndGuestSession(r.Context(), raw); err != nil {
		guestRespond(w, err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     guestCookieName,
		Path:     "/api/v1/guest",
		HttpOnly: true,
		Secure:   h.options.SecureCookies,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0).UTC(),
	})
	w.WriteHeader(204)
}

func (h *GuestHandler) owner(w http.ResponseWriter, r *http.Request) (cartOwner, bool) {
	raw, _, ok := h.credential(w, r)
	if !ok {
		return cartOwner{}, false
	}

	hash, err := GuestTokenDigest(raw)
	if err != nil {
		guestRespond(w, err)
		return cartOwner{}, false
	}

	return cartOwner{guestHash: hash}, true
}

func (h *GuestHandler) cart(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	owner, ok := h.owner(w, r)
	if !ok {
		return
	}

	cart, err := h.service.getCart(r.Context(), owner)
	if err != nil {
		guestRespond(w, err)
		return
	}

	httpjson.Write(w, 200, cart)
}

func (h *GuestHandler) add(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProductID string `json:"product_id"`
		Quantity  int64  `json:"quantity"`
	}

	if !httpjson.Decode(w, r, &input, []string{"product_id", "quantity"}, []string{"product_id", "quantity"}) {
		return
	}

	owner, ok := h.owner(w, r)
	if !ok {
		return
	}

	cart, err := h.service.addCartItem(r.Context(), owner, input.ProductID, input.Quantity)
	if err != nil {
		guestRespond(w, err)
		return
	}

	httpjson.Write(w, 200, cart)
}

func (h *GuestHandler) replace(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Quantity int64 `json:"quantity"`
	}
	if !httpjson.Decode(w, r, &input, []string{"quantity"}, []string{"quantity"}) {
		return
	}

	owner, ok := h.owner(w, r)
	if !ok {
		return
	}

	cart, err := h.service.updateCartItem(r.Context(), owner, chi.URLParam(r, "id"), input.Quantity)
	if err != nil {
		guestRespond(w, err)
		return
	}

	httpjson.Write(w, 200, cart)
}

func (h *GuestHandler) remove(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	owner, ok := h.owner(w, r)
	if !ok {
		return
	}

	if err := h.service.removeCartItem(r.Context(), owner, chi.URLParam(r, "id")); err != nil {
		guestRespond(w, err)
		return
	}

	w.WriteHeader(204)
}

func (h *GuestHandler) clear(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	owner, ok := h.owner(w, r)
	if !ok {
		return
	}

	if err := h.service.clearCart(r.Context(), owner); err != nil {
		guestRespond(w, err)
		return
	}

	w.WriteHeader(204)
}

func (h *GuestHandler) choice(w http.ResponseWriter, r *http.Request) {
	if !httpjson.Bodyless(w, r) {
		return
	}

	raw, _, ok := h.credential(w, r)
	if !ok {
		return
	}

	user, _ := auth.Principal(r.Context())
	sid, _ := auth.SessionID(r.Context())

	result, err := h.service.GetGuestCartChoice(r.Context(), user.ID, sid, raw)
	if err != nil {
		guestRespond(w, err)
		return
	}

	httpjson.Write(w, 200, result)
}

func (h *GuestHandler) choose(w http.ResponseWriter, r *http.Request) {
	var input CartChoiceInput
	fields := []string{"choice", "guest_cart_version", "account_cart_version"}
	if !httpjson.Decode(w, r, &input, fields, fields) {
		return
	}

	raw, _, ok := h.credential(w, r)
	if !ok {
		return
	}

	user, _ := auth.Principal(r.Context())
	sid, _ := auth.SessionID(r.Context())

	result, err := h.service.ChooseGuestCart(r.Context(), user.ID, sid, raw, input)
	if err != nil {
		guestRespond(w, err)
		return
	}

	httpjson.Write(w, 200, result)
}
