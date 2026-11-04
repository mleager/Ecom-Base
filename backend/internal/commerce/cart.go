package commerce

import (
	"context"
	"fmt"

	db "ecom/backend/internal/db/sqlc"

	"github.com/jackc/pgx/v5/pgtype"
)

type CartItem struct {
	ID        string `json:"id"`
	ProductID string `json:"product_id"`
	Quantity  int32  `json:"quantity"`
}

type Cart struct {
	ID      string     `json:"id"`
	Version int64      `json:"version"`
	Items   []CartItem `json:"items"`
}

func cartView(row db.Cart, items []db.CartItem) Cart {
	result := Cart{ID: idString(row.ID), Version: row.Version, Items: make([]CartItem, 0, len(items))}
	for _, item := range items {
		result.Items = append(result.Items, CartItem{ID: idString(item.ID), ProductID: idString(item.ProductID), Quantity: item.Quantity})
	}

	return result
}

func (s *Service) GetCart(ctx context.Context, userID string) (Cart, error) {
	user, err := parseID(userID)
	if err != nil {
		return Cart{}, err
	}

	return s.getCart(ctx, cartOwner{user: user})
}

type cartOwner struct {
	user      pgtype.UUID
	guestHash []byte
}

func (s *Service) getCart(ctx context.Context, owner cartOwner) (Cart, error) {
	return transact(ctx, s.pool, func(q *db.Queries) (Cart, error) {
		// A shared parent lock prevents returning items from a different version.
		row, err := lockOwnerCart(ctx, q, owner, false)
		if err != nil {
			return Cart{}, fmt.Errorf("persistent cart unavailable: %w", err)
		}
		items, err := q.ListCartItems(ctx, row.ID)
		if err != nil {
			return Cart{}, err
		}
		return cartView(row, items), nil
	})
}

// mutateCart is the single write protocol, also shared with future checkout:
// lock parent first, inspect items, apply the mutation, increment once, commit.
func (s *Service) mutateCart(ctx context.Context, owner cartOwner, mutate func(*db.Queries, db.Cart, []db.CartItem) error) (Cart, error) {
	return transact(ctx, s.pool, func(q *db.Queries) (Cart, error) {
		row, err := lockOwnerCart(ctx, q, owner, true)
		if err != nil {
			return Cart{}, fmt.Errorf("persistent cart unavailable: %w", err)
		}
		items, err := q.ListCartItems(ctx, row.ID)
		if err != nil {
			return Cart{}, err
		}
		if err := mutate(q, row, items); err != nil {
			return Cart{}, err
		}
		if row.Version >= MaxCartVersion {
			return Cart{}, ErrVersionExhausted
		}
		row.Version, err = q.IncrementCartVersion(ctx, row.ID)
		if err != nil {
			return Cart{}, err
		}
		items, err = q.ListCartItems(ctx, row.ID)
		if err != nil {
			return Cart{}, err
		}
		return cartView(row, items), nil
	})
}

func (s *Service) AddCartItem(ctx context.Context, userID, productID string, quantity int64) (Cart, error) {
	user, err := parseID(userID)
	if err != nil {
		return Cart{}, err
	}
	return s.addCartItem(ctx, cartOwner{user: user}, productID, quantity)
}

func (s *Service) addCartItem(ctx context.Context, owner cartOwner, productID string, quantity int64) (Cart, error) {
	product, err := parseID(productID)
	if err != nil {
		return Cart{}, err
	}

	if quantity < 1 || quantity > MaxQuantity {
		return Cart{}, ErrInvalidInput
	}

	id, err := newID()
	if err != nil {
		return Cart{}, err
	}

	return s.mutateCart(ctx, owner, func(q *db.Queries, row db.Cart, items []db.CartItem) error {
		if _, err := q.ActiveCartProduct(ctx, product); err != nil {
			return found(err)
		}
		for _, item := range items {
			if item.ProductID == product {
				total := int64(item.Quantity) + quantity
				if total > MaxQuantity {
					return ErrInvalidInput
				}
				return q.SetCartQuantity(ctx, db.SetCartQuantityParams{ID: item.ID, CartID: row.ID, Quantity: int32(total)})
			}
		}
		if len(items) >= MaxCartItems {
			return ErrCartFull
		}
		return q.InsertCartItem(ctx, db.InsertCartItemParams{ID: id, CartID: row.ID, ProductID: product, Quantity: int32(quantity)})
	})
}

func ownedItem(items []db.CartItem, id pgtype.UUID) (db.CartItem, error) {
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}

	return db.CartItem{}, ErrNotFound
}

func (s *Service) UpdateCartItem(ctx context.Context, userID, itemID string, quantity int64) (Cart, error) {
	user, err := parseID(userID)
	if err != nil {
		return Cart{}, err
	}
	return s.updateCartItem(ctx, cartOwner{user: user}, itemID, quantity)
}

func (s *Service) updateCartItem(ctx context.Context, owner cartOwner, itemID string, quantity int64) (Cart, error) {
	id, err := parseID(itemID)
	if err != nil {
		return Cart{}, err
	}

	if quantity < 1 || quantity > MaxQuantity {
		return Cart{}, ErrInvalidInput
	}

	return s.mutateCart(ctx, owner, func(q *db.Queries, row db.Cart, items []db.CartItem) error {
		item, err := ownedItem(items, id)
		if err != nil {
			return err
		}
		if _, err := q.ActiveCartProduct(ctx, item.ProductID); err != nil {
			return found(err)
		}
		return q.SetCartQuantity(ctx, db.SetCartQuantityParams{ID: id, CartID: row.ID, Quantity: int32(quantity)})
	})
}

func (s *Service) RemoveCartItem(ctx context.Context, userID, itemID string) error {
	user, err := parseID(userID)
	if err != nil {
		return err
	}
	return s.removeCartItem(ctx, cartOwner{user: user}, itemID)
}

func (s *Service) removeCartItem(ctx context.Context, owner cartOwner, itemID string) error {
	id, err := parseID(itemID)
	if err != nil {
		return err
	}

	_, err = s.mutateCart(ctx, owner, func(q *db.Queries, row db.Cart, items []db.CartItem) error {
		if _, err := ownedItem(items, id); err != nil {
			return err
		}
		return q.DeleteCartItem(ctx, db.DeleteCartItemParams{ID: id, CartID: row.ID})
	})

	return err
}

func (s *Service) ClearCart(ctx context.Context, userID string) error {
	user, err := parseID(userID)
	if err != nil {
		return err
	}
	return s.clearCart(ctx, cartOwner{user: user})
}

func (s *Service) clearCart(ctx context.Context, owner cartOwner) error {
	_, err := s.mutateCart(ctx, owner, func(q *db.Queries, row db.Cart, _ []db.CartItem) error { return q.ClearCart(ctx, row.ID) })
	return err
}
