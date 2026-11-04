package checkout

import (
	"bytes"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/httpjson"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	service      *Service
	authenticate func(http.Handler) http.Handler
	logger       *slog.Logger
}

func NewHandler(service *Service, authenticate func(http.Handler) http.Handler, logger *slog.Logger) *Handler {
	return &Handler{service, authenticate, logger}
}

func (h *Handler) Routes(api chi.Router) {
	api.Group(func(r chi.Router) {
		r.Use(h.authenticate)
		r.Post("/checkout", h.checkout)
		r.Get("/orders", h.list)
		r.Get("/orders/{id}", h.get)
		r.Get("/orders/{id}/payments", h.payments)
		r.Post("/orders/{id}/cancel", h.cancel)
	})
}

func requestActor(r *http.Request) string {
	user, _ := auth.Principal(r.Context())
	return user.ID
}

func (h *Handler) checkout(w http.ResponseWriter, r *http.Request) {
	keys := r.Header.Values("Idempotency-Key")
	if len(keys) != 1 {
		respondError(w, ErrInvalidKey)
		return
	}

	var input Request
	fields := []string{"cart_version", "shipping_address_id", "payment_scenario"}
	if !httpjson.Decode(w, r, &input, fields, fields) {
		return
	}

	result, err := h.service.Checkout(r.Context(), requestActor(r), keys[0], input)
	if err != nil {
		h.failure(w, r, err)
		return
	}

	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	} else if result.Interrupted {
		status = http.StatusAccepted
		h.logger.Warn("checkout processing interrupted", "request_id", w.Header().Get("X-Request-ID"), "order_id", result.Order.ID, "payment_status", result.Order.Payment.Status)
	}

	httpjson.Write(w, status, result.Order)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	limit, offset, err := httpjson.Pagination(r.URL.RawQuery)
	if err != nil {
		respondError(w, err)
		return
	}

	orders, err := h.service.ListOrders(r.Context(), requestActor(r), limit, offset)
	if err != nil {
		h.failure(w, r, err)
		return
	}

	httpjson.Write(w, http.StatusOK, orders)
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	order, err := h.service.GetOrder(r.Context(), requestActor(r), chi.URLParam(r, "id"))
	if err != nil {
		h.failure(w, r, err)
		return
	}

	httpjson.Write(w, http.StatusOK, order)
}

func (h *Handler) payments(w http.ResponseWriter, r *http.Request) {
	payments, err := h.service.Payments(r.Context(), requestActor(r), chi.URLParam(r, "id"))
	if err != nil {
		h.failure(w, r, err)
		return
	}

	httpjson.Write(w, http.StatusOK, payments)
}

func (h *Handler) cancel(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpjson.Error(w, 413, "body_too_large", "Request body exceeds 64 KiB")
		} else {
			httpjson.Error(w, 400, "bad_request", "Could not read request body")
		}
		return
	}

	if len(bytes.TrimSpace(body)) != 0 {
		httpjson.Error(w, 400, "bad_request", "Cancellation has no request body")
		return
	}

	order, err := h.service.Cancel(r.Context(), requestActor(r), chi.URLParam(r, "id"))
	if err != nil {
		h.failure(w, r, err)
		return
	}

	httpjson.Write(w, http.StatusOK, order)
}

func (h *Handler) failure(w http.ResponseWriter, r *http.Request, err error) {
	// Public/log messages never include SQL, addresses, tokens or simulator errors.
	if errors.Is(err, ErrIntegrity) {
		h.logger.Error("order integrity failure", "request_id", w.Header().Get("X-Request-ID"))
	}

	respondError(w, err)
}

func respondError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidKey):
		httpjson.Error(w, 400, "invalid_idempotency_key", "Exactly one 1-128 byte visible ASCII Idempotency-Key is required")
	case errors.Is(err, ErrMalformedID), errors.Is(err, httpjson.ErrPagination):
		httpjson.Error(w, 400, "bad_request", "Malformed UUID or pagination parameter")
	case errors.Is(err, ErrInvalidInput), errors.Is(err, httpjson.ErrPaginationBounds):
		httpjson.Error(w, 422, "invalid_input", "Input does not meet the documented requirements")
	case errors.Is(err, ErrInvalidTotal):
		httpjson.Error(w, 422, "invalid_checkout_total", "Checkout totals exceed documented numeric bounds")
	case errors.Is(err, ErrEmptyCart):
		httpjson.Error(w, 422, "empty_cart", "Cart is empty")
	case errors.Is(err, ErrUnauthorized):
		w.Header().Set("WWW-Authenticate", "Bearer")
		httpjson.Error(w, 401, "unauthorized", "Authentication required")
	case errors.Is(err, ErrOrderNotFound):
		httpjson.Error(w, 404, "order_not_found", "Order not found")
	case errors.Is(err, ErrAddressNotFound):
		httpjson.Error(w, 404, "address_not_found", "Shipping address not found")
	case errors.Is(err, ErrIdempotencyConflict):
		httpjson.Error(w, 409, "idempotency_conflict", "Key already belongs to different checkout intent")
	case errors.Is(err, ErrStaleCart):
		httpjson.Error(w, 409, "stale_cart", "Cart version is stale")
	case errors.Is(err, ErrProductUnavailable):
		httpjson.Error(w, 409, "product_unavailable", "Cart contains an unavailable product")
	case errors.Is(err, ErrInsufficientInventory):
		httpjson.Error(w, 409, "insufficient_inventory", "Insufficient available inventory")
	case errors.Is(err, ErrVersionExhausted):
		httpjson.Error(w, 409, "cart_version_exhausted", "Cart version cannot be incremented safely")
	case errors.Is(err, ErrCancellationConflict):
		httpjson.Error(w, 409, "cancellation_conflict", "Order can no longer be cancelled")
	case errors.Is(err, ErrOutcomeUncertain):
		httpjson.Error(w, 503, "checkout_outcome_uncertain", "Outcome could not be confirmed; retry the identical checkout key and body")
	case errors.Is(err, ErrOrderOutcomeUncertain):
		httpjson.Error(w, 503, "order_outcome_uncertain", "Outcome could not be confirmed; retry cancellation for the same order")
	default:
		httpjson.Error(w, 500, "internal_error", "Request could not be processed")
	}
}
