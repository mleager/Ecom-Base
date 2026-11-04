package commerce

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

type Product struct {
	ID                string `json:"id"`
	SKU               string `json:"sku"`
	Name              string `json:"name"`
	Description       string `json:"description"`
	ImageURL          string `json:"image_url"`
	UnitPriceCents    int64  `json:"unit_price_cents"`
	IsActive          bool   `json:"is_active"`
	AvailableQuantity int32  `json:"available_quantity"`
}

type ProductInput struct {
	SKU            *string `json:"sku"`
	Name           *string `json:"name"`
	Description    *string `json:"description"`
	ImageURL       *string `json:"image_url"`
	UnitPriceCents *int64  `json:"unit_price_cents"`
	IsActive       *bool   `json:"is_active"`
}

var skuPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func (p *ProductInput) valid(create bool) bool {
	if create && (p.SKU == nil || p.Name == nil || p.UnitPriceCents == nil || p.IsActive != nil) {
		return false
	}

	if !create && p.SKU == nil && p.Name == nil && p.Description == nil && p.ImageURL == nil && p.UnitPriceCents == nil && p.IsActive == nil {
		return false
	}

	if !normalizeText(p.SKU, 64, true) || !normalizeText(p.Name, 200, true) || !normalizeText(p.Description, 4000, false) || !normalizeText(p.ImageURL, 2048, false) {
		return false
	}

	if p.SKU != nil && !skuPattern.MatchString(*p.SKU) {
		return false
	}

	if p.UnitPriceCents != nil && (*p.UnitPriceCents < 0 || *p.UnitPriceCents > MaxPrice) {
		return false
	}

	if p.ImageURL != nil && *p.ImageURL != "" {
		image, err := url.Parse(*p.ImageURL)
		if err != nil || (image.Scheme != "http" && image.Scheme != "https") || image.Hostname() == "" || image.User != nil || strings.IndexFunc(*p.ImageURL, unicode.IsSpace) >= 0 {
			return false
		}
	}

	return true
}

func productView(p db.Product, available int32) Product {
	return Product{
		ID:                idString(p.ID),
		SKU:               p.Sku,
		Name:              p.Name,
		Description:       p.Description.String,
		ImageURL:          p.ImageUrl.String,
		UnitPriceCents:    p.UnitPriceCents,
		IsActive:          p.IsActive,
		AvailableQuantity: available,
	}
}

// Search is literal substring matching. Escape the chosen SQL LIKE escape
// character before escaping wildcards; values are still passed as parameters.
func productSearchPattern(search string) (string, error) {
	if !utf8.ValidString(search) || strings.ContainsRune(search, 0) {
		return "", ErrInvalidInput
	}
	search = strings.TrimSpace(search)
	if utf8.RuneCountInString(search) > 200 {
		return "", ErrInvalidInput
	}
	if search == "" {
		return "", nil
	}
	return "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(search) + "%", nil
}

func (s *Service) ListProducts(ctx context.Context, limit, offset int64, search string) ([]Product, error) {
	if limit < 1 || limit > 100 || offset < 0 {
		return nil, ErrInvalidInput
	}
	pattern, err := productSearchPattern(search)
	if err != nil {
		return nil, err
	}

	rows, err := s.queries.ListProducts(ctx, db.ListProductsParams{PageLimit: limit, PageOffset: offset, SearchPattern: pattern})
	if err != nil {
		return nil, err
	}

	result := make([]Product, 0, len(rows))
	for _, row := range rows {
		result = append(result, Product{
			ID:                idString(row.ID),
			SKU:               row.Sku,
			Name:              row.Name,
			Description:       row.Description.String,
			ImageURL:          row.ImageUrl.String,
			UnitPriceCents:    row.UnitPriceCents,
			IsActive:          row.IsActive,
			AvailableQuantity: row.AvailableQuantity,
		})
	}

	return result, nil
}

func (s *Service) GetProduct(ctx context.Context, productID string) (Product, error) {
	id, err := parseID(productID)
	if err != nil {
		return Product{}, err
	}

	row, err := s.queries.GetProduct(ctx, id)
	if err != nil {
		return Product{}, found(err)
	}

	return Product{
		ID:                idString(row.ID),
		SKU:               row.Sku,
		Name:              row.Name,
		Description:       row.Description.String,
		ImageURL:          row.ImageUrl.String,
		UnitPriceCents:    row.UnitPriceCents,
		IsActive:          row.IsActive,
		AvailableQuantity: row.AvailableQuantity,
	}, nil
}

func (s *Service) CreateProduct(ctx context.Context, input ProductInput) (Product, error) {
	if !input.valid(true) {
		return Product{}, ErrInvalidInput
	}

	id, err := newID()
	if err != nil {
		return Product{}, err
	}

	result, err := transact(ctx, s.pool, func(q *db.Queries) (Product, error) {
		row, err := q.CreateProduct(ctx, db.CreateProductParams{ID: id, Sku: *input.SKU, Name: *input.Name, Description: optionalText(input.Description), ImageUrl: optionalText(input.ImageURL), UnitPriceCents: *input.UnitPriceCents})
		if err != nil {
			return Product{}, err
		}
		if err := q.CreateInventory(ctx, id); err != nil {
			return Product{}, err
		}
		return productView(row, 0), nil
	})

	return result, skuError(err)
}

func (s *Service) UpdateProduct(ctx context.Context, productID string, input ProductInput) (Product, error) {
	id, err := parseID(productID)
	if err != nil {
		return Product{}, err
	}

	if !input.valid(false) {
		return Product{}, ErrInvalidInput
	}

	price := pgtype.Int8{}
	if input.UnitPriceCents != nil {
		price = pgtype.Int8{Int64: *input.UnitPriceCents, Valid: true}
	}

	active := pgtype.Bool{}
	if input.IsActive != nil {
		active = pgtype.Bool{Bool: *input.IsActive, Valid: true}
	}

	result, err := transact(ctx, s.pool, func(q *db.Queries) (Product, error) {
		row, err := q.UpdateProduct(ctx, db.UpdateProductParams{ID: id, Sku: text(input.SKU), Name: text(input.Name), SetDescription: input.Description != nil, Description: optionalText(input.Description), SetImageUrl: input.ImageURL != nil, ImageUrl: optionalText(input.ImageURL), UnitPriceCents: price, IsActive: active})
		if err != nil {
			return Product{}, err
		}
		inventory, err := q.GetInventory(ctx, id)
		if err != nil {
			return Product{}, err
		}
		return productView(row, inventory.QuantityOnHand-inventory.QuantityReserved), nil
	})

	return result, skuError(err)
}

func (s *Service) RetireProduct(ctx context.Context, productID string) error {
	id, err := parseID(productID)
	if err != nil {
		return err
	}

	count, err := s.queries.RetireProduct(ctx, id)
	if err == nil && count == 0 {
		return ErrNotFound
	}

	return err
}

type Inventory struct {
	ProductID         string `json:"product_id"`
	QuantityOnHand    int32  `json:"quantity_on_hand"`
	QuantityReserved  int32  `json:"quantity_reserved"`
	QuantityAvailable int32  `json:"quantity_available"`
}

var errInventoryMissing = errors.New("product inventory missing")

func (s *Service) ListAdminProducts(ctx context.Context, limit, offset int64, isActive *bool, search string) ([]Product, error) {
	if limit < 1 || limit > 100 || offset < 0 {
		return nil, ErrInvalidInput
	}
	pattern, err := productSearchPattern(search)
	if err != nil {
		return nil, err
	}
	active := pgtype.Bool{}
	if isActive != nil {
		active = pgtype.Bool{Bool: *isActive, Valid: true}
	}
	rows, err := s.queries.ListAdminProducts(ctx, db.ListAdminProductsParams{PageLimit: limit, PageOffset: offset, IsActive: active, SearchPattern: pattern})
	if err != nil {
		return nil, err
	}
	result := make([]Product, 0, len(rows))
	for _, row := range rows {
		if !row.InventoryProductID.Valid {
			return nil, errInventoryMissing
		}
		result = append(result, productView(row.Product, row.AvailableQuantity))
	}
	return result, nil
}

func (s *Service) GetAdminProduct(ctx context.Context, productID string) (Product, error) {
	id, err := parseID(productID)
	if err != nil {
		return Product{}, err
	}
	row, err := s.queries.GetAdminProduct(ctx, id)
	if err != nil {
		return Product{}, found(err)
	}
	if !row.InventoryProductID.Valid {
		return Product{}, errInventoryMissing
	}
	return productView(row.Product, row.AvailableQuantity), nil
}

func (s *Service) GetAdminInventory(ctx context.Context, productID string) (Inventory, error) {
	id, err := parseID(productID)
	if err != nil {
		return Inventory{}, err
	}
	row, err := s.queries.GetAdminInventory(ctx, id)
	if err != nil {
		return Inventory{}, found(err)
	}
	if !row.InventoryProductID.Valid {
		return Inventory{}, errInventoryMissing
	}
	return Inventory{ProductID: idString(row.ProductID), QuantityOnHand: row.QuantityOnHand, QuantityReserved: row.QuantityReserved, QuantityAvailable: row.QuantityOnHand - row.QuantityReserved}, nil
}

func (s *Service) AdjustInventory(ctx context.Context, productID string, delta int64) (Inventory, error) {
	id, err := parseID(productID)
	if err != nil {
		return Inventory{}, err
	}

	if delta < -MaxStock || delta > MaxStock {
		return Inventory{}, ErrInvalidInput
	}

	return transact(ctx, s.pool, func(q *db.Queries) (Inventory, error) {
		row, err := q.LockInventory(ctx, id)
		if err != nil {
			return Inventory{}, found(err)
		}
		onHand := int64(row.QuantityOnHand) + delta
		if onHand < int64(row.QuantityReserved) || onHand > MaxStock {
			return Inventory{}, ErrStockConflict
		}
		row, err = q.SetOnHand(ctx, db.SetOnHandParams{ProductID: id, QuantityOnHand: int32(onHand)})
		if err != nil {
			return Inventory{}, err
		}
		return Inventory{ProductID: idString(row.ProductID), QuantityOnHand: row.QuantityOnHand, QuantityReserved: row.QuantityReserved, QuantityAvailable: row.QuantityOnHand - row.QuantityReserved}, nil
	})
}
