package fixturecmd

import (
	"context"
	"errors"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/database"
	"ecom/fixtures"

	"github.com/jackc/pgx/v5"
)

func seed(ctx context.Context, migrator *pgx.Conn, bundle *Bundle, secret []byte) error {
	catalog, digest, err := fixtures.Load()
	if err != nil || catalog.Version != fixtures.Version {
		return errors.New("fixture catalog invalid")
	}

	bundle.FixtureSHA256 = digest
	tx, err := migrator.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())

	byKey := make(map[string]string)
	for _, p := range catalog.Products {
		var image any
		if p.Image != "" {
			image = bundle.Origin + "/fixtures/v1/" + p.Image
		}
		if _, err := tx.Exec(ctx, `INSERT INTO products(id,sku,name,description,image_url,unit_price_cents,is_active) VALUES($1,$2,$3,$4,$5,$6,$7)`, p.ID, p.SKU, p.Name, p.Description, image, p.Price, p.Active); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO inventory(product_id,quantity_on_hand) VALUES($1,$2)`, p.ID, p.Stock); err != nil {
			return err
		}
		byKey[p.Key] = p.ID
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	pool, err := database.Open(ctx, bundle.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := database.Ready(ctx, pool); err != nil {
		return err
	}

	authentication, err := auth.NewService(pool, secret, time.Now)
	if err != nil {
		return err
	}

	service := commerce.NewService(pool)
	for _, person := range []struct{ key, first, last, email, role string }{
		{"customer_one", "Avery", "River", "customer.one@example.test", "customer"},
		{"customer_two", "Jordan", "Stone", "customer.two@example.test", "customer"},
		{"admin", "Morgan", "Reed", "admin@example.test", "admin"},
	} {
		password, err := randomHex(32)
		if err != nil {
			return err
		}
		user, err := authentication.Register(ctx, auth.Registration{FirstName: person.first, LastName: person.last, Email: person.email, Password: password})
		if err != nil {
			return err
		}
		account := Account{ID: user.ID, Email: user.Email, Password: password, Role: person.role, AddressIDs: []string{}}
		if person.role == "admin" {
			changed, err := migrator.Exec(ctx, `UPDATE users SET role='admin' WHERE id=$1 AND email=$2 AND role='customer' AND is_active`, user.ID, user.Email)
			if err != nil || changed.RowsAffected() != 1 {
				return errors.New("new fixture administrator could not be provisioned")
			}
		} else {
			label, recipient, line, city, region, postal := "Home", person.first+" "+person.last, "100 Example Way", "Portland", "OR", "97201"
			address, err := service.CreateAddress(ctx, user.ID, commerce.AddressInput{Label: &label, RecipientName: &recipient, Line1: &line, City: &city, Region: &region, PostalCode: &postal})
			if err != nil {
				return err
			}
			account.AddressIDs = append(account.AddressIDs, address.ID)
		}
		bundle.Accounts[person.key] = account
	}

	userID := bundle.Accounts["customer_two"].ID
	for _, line := range []struct {
		key      string
		quantity int64
	}{{"lamp_amber", 2}, {"maximum_price", commerce.MaxQuantity}} {
		if _, err := service.AddCartItem(ctx, userID, byKey[line.key], line.quantity); err != nil {
			return err
		}
	}

	// This represents a cart line retained after retirement. Only the isolated
	// fixture database is touched, and the parent version advances with the line.
	tx, err = migrator.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())

	if _, err := tx.Exec(ctx, `INSERT INTO cart_items(id,cart_id,product_id,quantity) SELECT 'f2000000-0000-4000-8000-000000000001',id,$2,1 FROM carts WHERE user_id=$1`, userID, byKey["retired"]); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `UPDATE carts SET version=version+1,updated_at=now() WHERE user_id=$1`, userID); err != nil {
		return err
	}

	return tx.Commit(ctx)
}
