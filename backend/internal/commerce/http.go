package commerce

import (
	"context"
	"errors"
	"net/http"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/platform/httpjson"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	service      *Service
	authenticate func(http.Handler) http.Handler
}

func NewHandler(service *Service, authenticate func(http.Handler) http.Handler) *Handler {
	return &Handler{service: service, authenticate: authenticate}
}

func (h *Handler) Routes(api chi.Router) {
	api.Get("/products", h.handle(http.StatusOK, h.listProducts))
	api.Get("/products/{id}", h.handle(http.StatusOK, h.getProduct))
	api.Group(func(r chi.Router) {
		r.Use(h.authenticate)
		r.Patch("/users/me", h.handle(http.StatusOK, h.updateProfile))
		r.Get("/users/me/addresses", h.handle(http.StatusOK, h.listAddresses))
		r.Post("/users/me/addresses", h.handle(http.StatusCreated, h.createAddress))
		r.Patch("/users/me/addresses/{id}", h.handle(http.StatusOK, h.updateAddress))
		r.Delete("/users/me/addresses/{id}", h.handle(http.StatusNoContent, h.deleteAddress))
		r.Get("/cart", h.handle(http.StatusOK, h.getCart))
		r.Post("/cart/items", h.handle(http.StatusOK, h.addCartItem))
		r.Patch("/cart/items/{id}", h.handle(http.StatusOK, h.updateCartItem))
		r.Delete("/cart/items/{id}", h.handle(http.StatusNoContent, h.removeCartItem))
		r.Delete("/cart/items", h.handle(http.StatusNoContent, h.clearCart))
		r.Group(func(admin chi.Router) {
			admin.Use(auth.RequireAdmin)
			admin.Get("/admin/products", h.handle(http.StatusOK, h.listAdminProducts))
			admin.Get("/admin/products/{id}", h.handle(http.StatusOK, h.getAdminProduct))
			admin.Get("/admin/products/{id}/inventory", h.handle(http.StatusOK, h.getAdminInventory))
			admin.Post("/admin/products", h.handle(http.StatusCreated, h.createProduct))
			admin.Patch("/admin/products/{id}", h.handle(http.StatusOK, h.updateProduct))
			admin.Delete("/admin/products/{id}", h.handle(http.StatusNoContent, h.retireProduct))
			admin.Patch("/admin/products/{id}/inventory", h.handle(http.StatusOK, h.adjustInventory))
		})
	})
}

var (
	errResponseWritten = errors.New("response already written")
	errQuery           = errors.New("malformed query")
)

type endpoint func(http.ResponseWriter, *http.Request) (any, error)

func (h *Handler) handle(status int, endpoint endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		value, err := endpoint(w, r.WithContext(ctx))
		if err != nil {
			respondError(w, err)
			return
		}
		if status == http.StatusNoContent {
			w.WriteHeader(status)
			return
		}
		httpjson.Write(w, status, value)
	}
}

func respondError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errResponseWritten):
		return
	case errors.Is(err, ErrMalformedID), errors.Is(err, errQuery):
		httpjson.Error(w, 400, "bad_request", "Malformed UUID or query parameter")
	case errors.Is(err, ErrInvalidInput):
		httpjson.Error(w, 422, "invalid_input", "Input does not meet the documented requirements")
	case errors.Is(err, ErrNotFound):
		httpjson.Error(w, 404, "not_found", "Resource not found")
	case errors.Is(err, ErrSKUConflict):
		httpjson.Error(w, 409, "sku_conflict", "A product with this SKU already exists")
	case errors.Is(err, ErrStockConflict):
		httpjson.Error(w, 409, "inventory_conflict", "Stock adjustment exceeds bounds or existing reservations")
	case errors.Is(err, ErrCartFull):
		httpjson.Error(w, 409, "cart_full", "Cart may contain at most 100 distinct products")
	case errors.Is(err, ErrVersionExhausted):
		httpjson.Error(w, 409, "cart_version_exhausted", "Cart version cannot be incremented safely")
	default:
		// Database and transport errors have no safe public details.
		httpjson.Error(w, 500, "internal_error", "Request could not be processed")
	}
}

// All callers are mounted after Authenticate; client bodies cannot choose users.
func actor(r *http.Request) string { user, _ := auth.Principal(r.Context()); return user.ID }

func decode(w http.ResponseWriter, r *http.Request, value any, allowed, required []string) error {
	if !httpjson.Decode(w, r, value, allowed, required) {
		return errResponseWritten
	}
	return nil
}

func (h *Handler) updateProfile(w http.ResponseWriter, r *http.Request) (any, error) {
	var input ProfilePatch
	if err := decode(w, r, &input, []string{"first_name", "last_name"}, nil); err != nil {
		return nil, err
	}
	return h.service.UpdateProfile(r.Context(), actor(r), input)
}

var addressFields = []string{"label", "recipient_name", "line_1", "line_2", "city", "region", "postal_code"}

func (h *Handler) listAddresses(_ http.ResponseWriter, r *http.Request) (any, error) {
	return h.service.ListAddresses(r.Context(), actor(r))
}

func (h *Handler) createAddress(w http.ResponseWriter, r *http.Request) (any, error) {
	var input AddressInput
	allowed := append(append([]string{}, addressFields...), "country_code")
	if err := decode(w, r, &input, allowed, []string{"recipient_name", "line_1", "city", "region", "postal_code"}); err != nil {
		return nil, err
	}
	return h.service.CreateAddress(r.Context(), actor(r), input)
}

func (h *Handler) updateAddress(w http.ResponseWriter, r *http.Request) (any, error) {
	var input AddressInput
	if err := decode(w, r, &input, addressFields, nil); err != nil {
		return nil, err
	}
	return h.service.UpdateAddress(r.Context(), actor(r), chi.URLParam(r, "id"), input)
}

func (h *Handler) deleteAddress(_ http.ResponseWriter, r *http.Request) (any, error) {
	return nil, h.service.DeleteAddress(r.Context(), actor(r), chi.URLParam(r, "id"))
}

func pagination(raw string) (int64, int64, error) {
	limit, offset, err := httpjson.Pagination(raw)
	if errors.Is(err, httpjson.ErrPaginationBounds) {
		return 0, 0, ErrInvalidInput
	}
	if err != nil {
		return 0, 0, errQuery
	}
	return limit, offset, nil
}

func (h *Handler) listProducts(_ http.ResponseWriter, r *http.Request) (any, error) {
	query, err := parseProductQuery(r.URL.RawQuery, false)
	if err != nil {
		return nil, err
	}
	return h.service.ListProducts(r.Context(), query.limit, query.offset, query.search)
}

func (h *Handler) getProduct(_ http.ResponseWriter, r *http.Request) (any, error) {
	return h.service.GetProduct(r.Context(), chi.URLParam(r, "id"))
}

func (h *Handler) listAdminProducts(_ http.ResponseWriter, r *http.Request) (any, error) {
	query, err := parseProductQuery(r.URL.RawQuery, true)
	if err != nil {
		return nil, err
	}
	return h.service.ListAdminProducts(r.Context(), query.limit, query.offset, query.isActive, query.search)
}

func (h *Handler) getAdminProduct(_ http.ResponseWriter, r *http.Request) (any, error) {
	return h.service.GetAdminProduct(r.Context(), chi.URLParam(r, "id"))
}

func (h *Handler) getAdminInventory(_ http.ResponseWriter, r *http.Request) (any, error) {
	return h.service.GetAdminInventory(r.Context(), chi.URLParam(r, "id"))
}

var productFields = []string{"sku", "name", "description", "image_url", "unit_price_cents"}

func (h *Handler) createProduct(w http.ResponseWriter, r *http.Request) (any, error) {
	var input ProductInput
	if err := decode(w, r, &input, productFields, []string{"sku", "name", "unit_price_cents"}); err != nil {
		return nil, err
	}
	return h.service.CreateProduct(r.Context(), input)
}

func (h *Handler) updateProduct(w http.ResponseWriter, r *http.Request) (any, error) {
	var input ProductInput
	allowed := append(append([]string{}, productFields...), "is_active")
	if err := decode(w, r, &input, allowed, nil); err != nil {
		return nil, err
	}
	return h.service.UpdateProduct(r.Context(), chi.URLParam(r, "id"), input)
}

func (h *Handler) retireProduct(_ http.ResponseWriter, r *http.Request) (any, error) {
	return nil, h.service.RetireProduct(r.Context(), chi.URLParam(r, "id"))
}

func (h *Handler) adjustInventory(w http.ResponseWriter, r *http.Request) (any, error) {
	var input struct {
		Delta int64 `json:"delta"`
	}
	if err := decode(w, r, &input, []string{"delta"}, []string{"delta"}); err != nil {
		return nil, err
	}
	return h.service.AdjustInventory(r.Context(), chi.URLParam(r, "id"), input.Delta)
}

func (h *Handler) getCart(_ http.ResponseWriter, r *http.Request) (any, error) {
	return h.service.GetCart(r.Context(), actor(r))
}

func (h *Handler) addCartItem(w http.ResponseWriter, r *http.Request) (any, error) {
	var input struct {
		ProductID string `json:"product_id"`
		Quantity  int64  `json:"quantity"`
	}
	if err := decode(w, r, &input, []string{"product_id", "quantity"}, []string{"product_id", "quantity"}); err != nil {
		return nil, err
	}
	return h.service.AddCartItem(r.Context(), actor(r), input.ProductID, input.Quantity)
}

func (h *Handler) updateCartItem(w http.ResponseWriter, r *http.Request) (any, error) {
	var input struct {
		Quantity int64 `json:"quantity"`
	}
	if err := decode(w, r, &input, []string{"quantity"}, []string{"quantity"}); err != nil {
		return nil, err
	}
	return h.service.UpdateCartItem(r.Context(), actor(r), chi.URLParam(r, "id"), input.Quantity)
}

func (h *Handler) removeCartItem(_ http.ResponseWriter, r *http.Request) (any, error) {
	return nil, h.service.RemoveCartItem(r.Context(), actor(r), chi.URLParam(r, "id"))
}

func (h *Handler) clearCart(_ http.ResponseWriter, r *http.Request) (any, error) {
	return nil, h.service.ClearCart(r.Context(), actor(r))
}
