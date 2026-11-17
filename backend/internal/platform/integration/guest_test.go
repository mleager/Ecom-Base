//go:build integration

package integration

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/maintaincmd"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func newGuestAPI(t *testing.T, f *testDatabase) authAPI {
	t.Helper()
	service, err := auth.NewService(f.pool, []byte(strings.Repeat("test-key", 4)), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	options := auth.HTTPOptions{Origin: authTestOrigin}
	a := auth.NewHandler(service, options)
	c := commerce.NewHandler(commerce.NewService(f.pool), a.Authenticate)
	g := commerce.NewGuestHandler(commerce.NewService(f.pool), a.Authenticate, options)
	s := httpserver.New("127.0.0.1:8080", func(ctx context.Context) error { return database.Ready(ctx, f.pool) }, slog.New(slog.NewTextHandler(io.Discard, nil)), a.RoutesWith(c.Routes, g.Routes))
	server := httptest.NewServer(s.Handler)
	t.Cleanup(server.Close)
	return authAPI{server}
}

func createGuest(t *testing.T, api authAPI) (commerce.GuestSession, *http.Cookie) {
	t.Helper()
	r := api.request(t, "POST", "/api/v1/guest/session", "", "", nil, true, 201)
	if len(r.cookies) != 1 || len(r.cookies[0].Value) != 43 || strings.Contains(string(r.body), r.cookies[0].Value) {
		t.Fatal("guest secret leaked or missing")
	}
	return decodeResponse[commerce.GuestSession](t, r), r.cookies[0]
}

func guestCart(t *testing.T, api authAPI, cookie *http.Cookie) commerce.Cart {
	t.Helper()
	return decodeResponse[commerce.Cart](t, api.request(t, "GET", "/api/v1/guest/cart", "", "", cookie, false, 200))
}

func TestGuestSessionsAndCarts(t *testing.T) {
	f := newTestDatabase(t)
	api := newGuestAPI(t, f)
	guest, cookie := createGuest(t, api)
	other, otherCookie := createGuest(t, api)
	if guest.GuestID == other.GuestID || cookie.HttpOnly != true || cookie.SameSite != http.SameSiteStrictMode || cookie.Path != "/api/v1/guest" || cookie.Domain != "" {
		t.Fatal("invalid guest isolation/cookie")
	}
	if span := guest.ExpiresAt.Sub(time.Now()); span < 29*24*time.Hour || span > 31*24*time.Hour {
		t.Fatal("guest lifetime differs")
	}
	var users, addresses int
	if err := f.migrator.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM addresses)`).Scan(&users, &addresses); err != nil || users != 0 || addresses != 0 {
		t.Fatal("guest created account rows")
	}
	decoded, _ := base64.RawURLEncoding.DecodeString(cookie.Value)
	hash := sha256.Sum256(decoded)
	var stored []byte
	if err := f.migrator.QueryRow(f.ctx, `SELECT token_hash FROM guest_sessions WHERE guest_id=$1`, guest.GuestID).Scan(&stored); err != nil || string(stored) != string(hash[:]) {
		t.Fatal("guest verifier not hashed")
	}
	initial := guestCart(t, api, cookie)
	if initial.Version != 1 || initial.Items == nil || len(initial.Items) != 0 {
		t.Fatal("new cart shape")
	}
	repeat := api.request(t, "POST", "/api/v1/guest/session", "", "", cookie, true, 200)
	if len(repeat.cookies) != 0 || decodeResponse[commerce.GuestSession](t, repeat) != guest {
		t.Fatal("bootstrap replaced existing guest")
	}
	api.request(t, "GET", "/api/v1/cart", "", "", cookie, false, 401)
	product := seedCatalogProduct(t, f, "GUEST", "Guest product", true)
	added := decodeResponse[commerce.Cart](t, api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":2}`, product), "", cookie, true, 200))
	if added.Version != 2 || len(added.Items) != 1 || added.Items[0].Quantity != 2 {
		t.Fatal("guest add/version")
	}
	// A separate handler/process-local limiter still observes the persistent cart.
	if current := guestCart(t, newGuestAPI(t, f), cookie); current.ID != added.ID || current.Version != 2 {
		t.Fatal("cart did not survive handler restart")
	}
	api.request(t, "PATCH", "/api/v1/guest/cart/items/"+added.Items[0].ID, `{"quantity":3}`, "", otherCookie, true, 404)
	api.request(t, "DELETE", "/api/v1/guest/cart/items/"+added.Items[0].ID, "", "", otherCookie, true, 404)
	updated := decodeResponse[commerce.Cart](t, api.request(t, "PATCH", "/api/v1/guest/cart/items/"+added.Items[0].ID, `{"quantity":10000}`, "", cookie, true, 200))
	if updated.Version != 3 || updated.Items[0].Quantity != 10000 {
		t.Fatal("quantity capped by stock")
	}
	api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product), "", cookie, true, 422)
	if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET is_active=false WHERE id=$1`, product); err != nil {
		t.Fatal(err)
	}
	api.request(t, "PATCH", "/api/v1/guest/cart/items/"+added.Items[0].ID, `{"quantity":1}`, "", cookie, true, 404)
	api.request(t, "DELETE", "/api/v1/guest/cart/items/"+added.Items[0].ID, "", "", cookie, true, 204)
	if current := guestCart(t, api, cookie); current.Version != 4 || len(current.Items) != 0 {
		t.Fatal("retired removal failed")
	}
	rotated := api.request(t, "POST", "/api/v1/guest/session/rotate", "", "", cookie, true, 200)
	if len(rotated.cookies) != 1 || rotated.cookies[0].Value == cookie.Value || decodeResponse[commerce.GuestSession](t, rotated) != guest {
		t.Fatal("rotation changed owner/deadline")
	}
	api.request(t, "GET", "/api/v1/guest/session", "", "", cookie, false, 401)
	api.request(t, "POST", "/api/v1/guest/session", "", "", cookie, true, 401)
	cookie = rotated.cookies[0]
	if current := guestCart(t, api, cookie); current.ID != initial.ID {
		t.Fatal("rotation lost cart")
	}
	api.request(t, "DELETE", "/api/v1/guest/session", "", "", cookie, true, 204)
	api.request(t, "GET", "/api/v1/guest/session", "", "", cookie, false, 401)
	api.request(t, "DELETE", "/api/v1/guest/session", "", "", nil, true, 204)
	api.request(t, "DELETE", "/api/v1/guest/session", "", "", &http.Cookie{Name: "ecom_guest", Value: "unrecognized"}, true, 204)
}

func TestGuestCartChoice(t *testing.T) {
	f := newTestDatabase(t)
	api := newGuestAPI(t, f)
	guest, cookie := createGuest(t, api)
	user := decodeResponse[auth.User](t, api.request(t, "POST", "/api/v1/auth/register", registrationBody("choice@example.test"), "", nil, false, 201))
	tokens, refresh := decodeTokens(t, api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, authTestPassword), "", nil, true, 200))
	product := seedCatalogProduct(t, f, "GUEST", "Guest selection", true)
	other := seedCatalogProduct(t, f, "ACCOUNT", "Account selection", true)
	api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":3}`, product), "", cookie, true, 200)
	api.request(t, "POST", "/api/v1/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, other), tokens.AccessToken, nil, false, 200)
	status := decodeResponse[commerce.CartChoiceStatus](t, api.request(t, "GET", "/api/v1/guest/cart-choice", "", tokens.AccessToken, cookie, false, 200))
	if !status.Required || status.GuestCartVersion != 2 || status.AccountCartVersion != 2 {
		t.Fatal("missing cart choice")
	}
	api.request(t, "GET", "/api/v1/guest/cart-choice", "", "", cookie, false, 401)
	api.request(t, "GET", "/api/v1/guest/cart-choice", "", tokens.AccessToken, nil, false, 401)
	keep := `{"choice":"keep_account","guest_cart_version":2,"account_cart_version":2}`
	result := decodeResponse[commerce.CartChoiceResult](t, api.request(t, "POST", "/api/v1/guest/cart-choice", keep, tokens.AccessToken, cookie, true, 200))
	if result.Cart.Version != 2 || result.Cart.Items[0].ProductID != other {
		t.Fatal("keep mutated cart")
	}
	status = decodeResponse[commerce.CartChoiceStatus](t, api.request(t, "GET", "/api/v1/guest/cart-choice", "", tokens.AccessToken, cookie, false, 200))
	if status.Required || status.Choice != "keep_account" {
		t.Fatal("choice receipt missing")
	}
	api.request(t, "POST", "/api/v1/guest/cart-choice", `{"choice":"use_guest","guest_cart_version":2,"account_cart_version":2}`, tokens.AccessToken, cookie, true, 409)
	// A genuinely changed guest cart requires a new explicit decision.
	api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product), "", cookie, true, 200)
	// An unavailable product can still be adopted and removed; no reservation occurs.
	if _, err := f.migrator.Exec(f.ctx, `UPDATE products SET is_active=false WHERE id=$1`, product); err != nil {
		t.Fatal(err)
	}
	body := `{"choice":"use_guest","guest_cart_version":3,"account_cart_version":2}`
	start := make(chan struct{})
	results := make([]authResponse, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results[i], errs[i] = api.do("POST", "/api/v1/guest/cart-choice", body, tokens.AccessToken, cookie, true)
		}()
	}
	close(start)
	wg.Wait()
	for i, r := range results {
		if errs[i] != nil || r.status != 200 {
			t.Fatalf("duplicate choice status %d: %s", r.status, r.body)
		}
	}
	result = decodeResponse[commerce.CartChoiceResult](t, results[0])
	if result.Cart.Version != 3 || len(result.Cart.Items) != 1 || result.Cart.Items[0].ProductID != product || result.Cart.Items[0].Quantity != 4 {
		t.Fatal("adoption merged or repeated")
	}
	if current := guestCart(t, api, cookie); current.Version != 4 || len(current.Items) != 0 {
		t.Fatal("guest not cleared once")
	}
	// Once the guest changes, an old duplicate cannot overwrite the latest decision.
	api.request(t, "DELETE", "/api/v1/guest/cart/items", "", "", cookie, true, 204)
	api.request(t, "POST", "/api/v1/guest/cart-choice", body, tokens.AccessToken, cookie, true, 409)
	status = decodeResponse[commerce.CartChoiceStatus](t, api.request(t, "GET", "/api/v1/guest/cart-choice", "", tokens.AccessToken, cookie, false, 200))
	// Empty guest carts need no transfer even after a version change.
	if status.Required || status.Choice != "" {
		t.Fatal("stale receipt reused")
	}
	api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":2}`, other), "", cookie, true, 200)
	var cartID string
	if err := f.migrator.QueryRow(f.ctx, `SELECT id FROM carts WHERE guest_id=$1`, guest.GuestID).Scan(&cartID); err != nil {
		t.Fatal(err)
	}
	_, err := f.migrator.Exec(f.ctx, `INSERT INTO guest_checkout_intents(id,guest_id,idempotency_key,source_cart_id,cart_version,payment_scenario,payload_hash,contact_digest,contact_email,shipping_address,state,expires_at) VALUES($1,$2,$3,$4,6,'reject',$5,$5,'test@example.test','{}','prepared',clock_timestamp()+interval '1 day')`, checkoutID(t), guest.GuestID, checkoutID(t), cartID, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	blocked := api.request(t, "POST", "/api/v1/guest/cart-choice", `{"choice":"use_guest","guest_cart_version":6,"account_cart_version":3}`, tokens.AccessToken, cookie, true, 409)
	var problem struct{ Code, Message string }
	_ = json.Unmarshal(blocked.body, &problem)
	if problem.Code != "guest_checkout_unresolved" {
		t.Fatal("prepared intent did not guard transfer")
	}
	api.request(t, "POST", "/api/v1/guest/cart-choice", `{"choice":"keep_account","guest_cart_version":6,"account_cart_version":3}`, tokens.AccessToken, cookie, true, 200)
	api.request(t, "POST", "/api/v1/auth/logout", "", "", refresh, true, 204)
	api.request(t, "GET", "/api/v1/guest/cart-choice", "", tokens.AccessToken, cookie, false, 401)
	if current := guestCart(t, api, cookie); len(current.Items) != 1 {
		t.Fatal("account logout destroyed guest cart")
	}
}

func TestGuestSchemaAndConcurrency(t *testing.T) {
	f := newTestDatabase(t)
	api := newGuestAPI(t, f)
	guest, cookie := createGuest(t, api)
	product := seedCatalogProduct(t, f, "CONCURRENT", "Concurrent", true)
	start := make(chan struct{})
	results := make([]authResponse, 12)
	errs := make([]error, 12)
	var wg sync.WaitGroup
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results[i], errs[i] = api.do("POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product), "", cookie, true)
		}()
	}
	close(start)
	wg.Wait()
	for i, r := range results {
		if errs[i] != nil || r.status != 200 {
			t.Fatalf("concurrent add status=%d body=%s", r.status, r.body)
		}
	}
	if cart := guestCart(t, api, cookie); cart.Version != 13 || len(cart.Items) != 1 || cart.Items[0].Quantity != 12 {
		t.Fatal("lost guest mutation/version")
	}
	for _, statement := range []string{
		`UPDATE carts SET guest_id=NULL WHERE guest_id='` + guest.GuestID + `'`,
		`UPDATE guest_sessions SET token_hash='x' WHERE guest_id='` + guest.GuestID + `'`,
	} {
		_, err := f.migrator.Exec(f.ctx, statement)
		var pg *pgconn.PgError
		if !errorsAsPG(err, &pg, "23514") {
			t.Fatal("ownership/verifier constraint missing")
		}
	}
	for _, statement := range []string{
		`UPDATE carts SET guest_id=guest_id`, `UPDATE guest_principals SET id=id`,
		`DELETE FROM guest_sessions`, `DELETE FROM guest_checkout_intents`,
		`UPDATE guest_checkout_intents SET payment_scenario='reject'`,
	} {
		_, err := f.pool.Exec(f.ctx, statement)
		var pg *pgconn.PgError
		if !errorsAsPG(err, &pg, "42501") {
			t.Fatal("runtime has excessive guest permissions")
		}
	}
	_, source, _, _ := runtime.Caller(0)
	contents, err := os.ReadFile(filepath.Join(filepath.Dir(source), "../../../migrations/00012_guest_carts.sql"))
	if err != nil {
		t.Fatal(err)
	}
	down := strings.Split(string(contents), "-- +goose Down")[1]
	tx, err := f.migrator.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(f.ctx, down)
	var pg *pgconn.PgError
	if !errorsAsPG(err, &pg, "P0001") {
		t.Fatal("down migration did not refuse guest data")
	}
	_ = tx.Rollback(f.ctx)
	// Expiry and version exhaustion are checked against durable database state.
	if _, err := f.migrator.Exec(f.ctx, `UPDATE carts SET version=9007199254740991 WHERE guest_id=$1`, guest.GuestID); err != nil {
		t.Fatal(err)
	}
	api.request(t, "DELETE", "/api/v1/guest/cart/items", "", "", cookie, true, 409)
	if _, err := f.migrator.Exec(f.ctx, `UPDATE guest_sessions SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second' WHERE guest_id=$1`, guest.GuestID); err != nil {
		t.Fatal(err)
	}
	api.request(t, "GET", "/api/v1/guest/cart", "", "", cookie, false, 401)
	api.request(t, "POST", "/api/v1/guest/session", "", "", cookie, true, 401)
	api.request(t, "DELETE", "/api/v1/guest/session", "", "", cookie, true, 204)
}

func errorsAsPG(err error, target **pgconn.PgError, code string) bool {
	return errors.As(err, target) && (*target).Code == code
}

func TestGuestCommitUncertainty(t *testing.T) {
	for _, mode := range []commitFaultMode{commitDropBefore, commitDropAfter} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			f := newTestDatabase(t)
			api := newGuestAPI(t, f)
			guest, cookie := createGuest(t, api)
			user := decodeResponse[auth.User](t, api.request(t, "POST", "/api/v1/auth/register", registrationBody("uncertain@example.test"), "", nil, false, 201))
			product := seedCatalogProduct(t, f, "UNCERTAIN", "Uncertain", true)
			api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":2}`, product), "", cookie, true, 200)
			api.request(t, "POST", "/api/v1/auth/login", credentialsBody(user.Email, authTestPassword), "", nil, true, 200)
			var sid string
			if err := f.migrator.QueryRow(f.ctx, `SELECT id FROM user_sessions WHERE user_id=$1`, user.ID).Scan(&sid); err != nil {
				t.Fatal(err)
			}
			pool, fault := newCommitFaultPool(t, f, mode)
			input := commerce.CartChoiceInput{Choice: "use_guest", GuestCartVersion: 2, AccountCartVersion: 1}
			if _, err := commerce.NewService(pool).ChooseGuestCart(f.ctx, user.ID, sid, cookie.Value, input); err == nil || !fault.used.Load() {
				t.Fatal("lost commit was treated as known success")
			}
			awaitCommitFault(t, fault)
			service := commerce.NewService(f.pool)
			status, err := service.GetGuestCartChoice(f.ctx, user.ID, sid, cookie.Value)
			if err != nil {
				t.Fatal(err)
			}
			committed := mode == commitDropAfter
			if (status.Choice == "use_guest") != committed || status.GuestCartVersion != map[bool]int64{false: 2, true: 3}[committed] {
				t.Fatal("readback lost true transaction outcome")
			}
			// Deliberate same-tuple retry resolves the existing receipt or applies the rolled-back choice.
			result, err := service.ChooseGuestCart(f.ctx, user.ID, sid, cookie.Value, input)
			if err != nil || result.Cart.Version != 2 || len(result.Cart.Items) != 1 || result.Cart.Items[0].Quantity != 2 {
				t.Fatal("choice retry duplicated/lost contents")
			}
			if cart := guestCart(t, api, cookie); cart.Version != 3 || len(cart.Items) != 0 {
				t.Fatal("choice cleared more than once")
			}
			if _, err := f.migrator.Exec(f.ctx, `UPDATE guest_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE guest_id=$1`, guest.GuestID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestGuestCapacityAndMaintenance(t *testing.T) {
	f := newTestDatabase(t)
	api := newGuestAPI(t, f)
	guest, cookie := createGuest(t, api)
	product := seedCatalogProduct(t, f, "CAPACITY-EXTRA", "Extra product", true)
	_, err := f.migrator.Exec(f.ctx, `INSERT INTO products(id,sku,name,unit_price_cents) SELECT md5('guest-cap-'||n)::uuid,'GC-'||n,'Guest capacity '||n,1 FROM generate_series(1,100) AS n;
INSERT INTO inventory(product_id) SELECT id FROM products WHERE sku LIKE 'GC-%';
INSERT INTO cart_items(id,cart_id,product_id,quantity) SELECT p.id,c.id,p.id,1 FROM products p CROSS JOIN carts c WHERE p.sku LIKE 'GC-%' AND c.guest_id=$1`, pgx.QueryExecModeSimpleProtocol, guest.GuestID)
	if err != nil {
		t.Fatal(err)
	}
	api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, product), "", cookie, true, 409)
	cart := guestCart(t, api, cookie)
	if cart.Version != 1 || len(cart.Items) != 100 {
		t.Fatal("capacity refusal mutated cart")
	}
	api.request(t, "POST", "/api/v1/guest/cart/items", fmt.Sprintf(`{"product_id":%q,"quantity":1}`, cart.Items[0].ProductID), "", cookie, true, 200)
	// Creation is not capped or serialized (M17 task 8): concurrent
	// creations through separate services all succeed.
	start := make(chan struct{})
	errs := make([]error, 8)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, _, errs[i] = commerce.NewService(f.pool).CreateGuestSession(f.ctx)
		}()
	}
	close(start)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	// maintain guests removes only guests whose sessions expired at least 7
	// days ago, 500 per batch, as the migrator only.
	_, err = f.migrator.Exec(f.ctx, `INSERT INTO guest_principals(id,created_at) SELECT md5('old-guest-'||n)::uuid,clock_timestamp()-interval '40 days' FROM generate_series(1,501) AS n;
INSERT INTO guest_sessions(id,guest_id,token_hash,created_at,expires_at) SELECT id,id,decode(md5(id::text)||md5(id::text),'hex'),clock_timestamp()-interval '40 days',clock_timestamp()-interval '10 days' FROM guest_principals WHERE created_at<clock_timestamp()-interval '39 days';
INSERT INTO carts(id,guest_id) SELECT id,id FROM guest_principals WHERE created_at<clock_timestamp()-interval '39 days'`)
	if err != nil {
		t.Fatal(err)
	}
	maintain := func(url string, args ...string) ([]maintaincmd.Batch, maintaincmd.Summary, error) {
		var output strings.Builder
		env := map[string]string{"APP_ENV": "local", "DATABASE_URL": url}
		ctx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
		defer cancel()
		err := maintaincmd.Run(ctx, append([]string{"guests"}, args...), func(key string) string { return env[key] }, &output, io.Discard)
		var batches []maintaincmd.Batch
		var summary maintaincmd.Summary
		for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
			if strings.Contains(line, `"event":"batch"`) {
				var b maintaincmd.Batch
				if json.Unmarshal([]byte(line), &b) != nil {
					t.Fatalf("bad batch line %q", line)
				}
				batches = append(batches, b)
			} else if line != "" && json.Unmarshal([]byte(line), &summary) != nil {
				t.Fatalf("bad summary line %q", line)
			}
		}
		return batches, summary, err
	}
	countOld := func() (old int) {
		if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FROM guest_principals WHERE created_at<clock_timestamp()-interval '39 days'`).Scan(&old); err != nil {
			t.Fatal(err)
		}
		return old
	}
	if _, _, err := maintain(f.appURL); err == nil || countOld() != 501 {
		t.Fatal("the runtime role ran guest maintenance")
	}
	if _, summary, err := maintain(f.migratorURL, "--max-batches", "1"); err != nil || summary.Batches != 1 || summary.Complete || countOld() != 1 {
		t.Fatalf("one batch: summary=%+v err=%v old=%d", summary, err, countOld())
	}
	// Idle expiry lets a guest go well before 30 days: one idle-expired 8
	// days ago is removed, one idle-expired 1 day ago is kept.
	_, err = f.migrator.Exec(f.ctx, `INSERT INTO guest_principals(id,created_at) VALUES(md5('idle-gone')::uuid,clock_timestamp()-interval '15 days'),(md5('idle-kept')::uuid,clock_timestamp()-interval '8 days');
INSERT INTO guest_sessions(id,guest_id,token_hash,created_at,expires_at,absolute_expires_at) SELECT id,id,decode(md5(id::text)||md5(id::text),'hex'),created_at,created_at+interval '7 days',created_at+interval '30 days' FROM guest_principals WHERE id IN (md5('idle-gone')::uuid,md5('idle-kept')::uuid);
INSERT INTO carts(id,guest_id) SELECT id,id FROM guest_principals WHERE id IN (md5('idle-gone')::uuid,md5('idle-kept')::uuid)`)
	if err != nil {
		t.Fatal(err)
	}
	batches, summary, err := maintain(f.migratorURL)
	if err != nil || !summary.Complete || len(batches) != summary.Batches || batches[len(batches)-1].Deleted != 0 || summary.Deleted == 0 || countOld() != 0 {
		t.Fatalf("full run: batches=%+v summary=%+v err=%v old=%d", batches, summary, err, countOld())
	}
	var gone, kept int
	if err := f.migrator.QueryRow(f.ctx, `SELECT count(*) FILTER (WHERE id=md5('idle-gone')::uuid),count(*) FILTER (WHERE id=md5('idle-kept')::uuid) FROM guest_principals`).Scan(&gone, &kept); err != nil || gone != 0 || kept != 1 {
		t.Fatalf("idle cleanup: gone=%d kept=%d err=%v", gone, kept, err)
	}
	if current := guestCart(t, api, cookie); current.ID != cart.ID || len(current.Items) != 100 {
		t.Fatal("maintenance touched active guest")
	}
}

func TestGuestRotationAndWaitingExpiry(t *testing.T) {
	f := newTestDatabase(t)
	api := newGuestAPI(t, f)
	guest, cookie := createGuest(t, api)
	service := commerce.NewService(f.pool)
	start := make(chan struct{})
	errs := make([]error, 2)
	next := make([]string, 2)
	views := make([]commerce.GuestSession, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			views[i], next[i], errs[i] = service.RotateGuestSession(f.ctx, cookie.Value)
		}()
	}
	close(start)
	wg.Wait()
	winner, refused := -1, 0
	for i, err := range errs {
		if err == nil {
			if winner != -1 {
				t.Fatal("rotation admitted both credentials")
			}
			winner = i
		} else if errors.Is(err, commerce.ErrGuestSession) {
			refused++
		} else {
			t.Fatal(err)
		}
	}
	if winner < 0 || refused != 1 || views[winner].GuestID != guest.GuestID || !views[winner].ExpiresAt.Equal(guest.ExpiresAt) {
		t.Fatal("rotation changed owner/deadline")
	}
	current := next[winner]
	tx, err := f.migrator.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(f.ctx) }()
	if _, err := tx.Exec(f.ctx, `SELECT id FROM guest_principals WHERE id=$1 FOR UPDATE`, guest.GuestID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := service.GetGuestSession(f.ctx, current); done <- err }()
	deadline := time.Now().Add(time.Second)
	waiting := false
	for !waiting && time.Now().Before(deadline) {
		if err := f.pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%name: ReadLockGuestPrincipal :one%' AND wait_event_type='Lock')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if !waiting {
			time.Sleep(5 * time.Millisecond)
		}
	}
	if !waiting {
		t.Fatal("guest verification did not reach lock barrier")
	}
	if _, err := tx.Exec(f.ctx, `UPDATE guest_sessions SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second' WHERE guest_id=$1`, guest.GuestID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, commerce.ErrGuestSession) {
		t.Fatal("guest verification trusted pre-lock expiry")
	}
}

func TestGuestUpgradePreservesAccounts(t *testing.T) {
	f := newTestDatabase(t)
	product := seedCheckoutProduct(t, f, 10, 100)
	c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
	if _, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "pre-guest-user-key", c.request); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var value string
		if err := f.migrator.QueryRow(f.ctx, `SELECT jsonb_build_object('carts',(SELECT jsonb_agg(to_jsonb(c)-'guest_id' ORDER BY c.id) FROM carts c),
 'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM cart_items i),
 'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM orders o),
 'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.idempotency_key) FROM checkout_idempotency k))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	f.migrate("down")
	if err := database.Ready(f.ctx, f.pool); err == nil {
		t.Fatal("new binary accepted the previous schema")
	}
	f.migrate("up")
	if after := snapshot(); after != before {
		t.Fatal("guest upgrade rewrote user cart/order/key data")
	}
	if result, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "pre-guest-user-key", c.request); err != nil || !result.Replayed {
		t.Fatal("guest upgrade broke existing user fingerprint")
	}
}

// Sessions end after 7 idle days and 30 days at most (M17 task 8). The API's
// expires_at stays the absolute deadline; the cookie follows the idle one.
func TestGuestIdleExpiry(t *testing.T) {
	f := newTestDatabase(t)
	api := newGuestAPI(t, f)
	guest, cookie := createGuest(t, api)
	within := func(at time.Time, want time.Duration) bool {
		d := time.Until(at) - want
		return d > -2*time.Minute && d < 2*time.Minute
	}
	if !within(guest.ExpiresAt, 30*24*time.Hour) || !within(cookie.Expires, 7*24*time.Hour) {
		t.Fatalf("new session: expires_at=%v cookie=%v", guest.ExpiresAt, cookie.Expires)
	}
	idle := func(guestID string) (deadline time.Time) {
		if err := f.migrator.QueryRow(f.ctx, `SELECT expires_at FROM guest_sessions WHERE guest_id=$1 AND revoked_at IS NULL`, guestID).Scan(&deadline); err != nil {
			t.Fatal(err)
		}
		return deadline
	}
	set := func(guestID, sql string) {
		if _, err := f.migrator.Exec(f.ctx, `UPDATE guest_sessions SET `+sql+` WHERE guest_id=$1 AND revoked_at IS NULL`, guestID); err != nil {
			t.Fatal(err)
		}
	}
	read := func(c *http.Cookie, status int) (commerce.GuestSession, []*http.Cookie) {
		r := api.request(t, "GET", "/api/v1/guest/session", "", "", c, false, status)
		if status != 200 {
			return commerce.GuestSession{}, r.cookies
		}
		return decodeResponse[commerce.GuestSession](t, r), r.cookies
	}

	// Five idle days later, use moves the idle deadline 7 days ahead and
	// renews the cookie; the absolute deadline doesn't move.
	set(guest.GuestID, `expires_at=clock_timestamp()+interval '2 days'`)
	view, cookies := read(cookie, 200)
	if !view.ExpiresAt.Equal(guest.ExpiresAt) || len(cookies) != 1 || cookies[0].Value != cookie.Value || cookies[0].Path != "/api/v1/guest" || !within(cookies[0].Expires, 7*24*time.Hour) || !within(idle(guest.GuestID), 7*24*time.Hour) {
		t.Fatalf("extension: view=%+v cookies=%v", view, cookies)
	}
	// Within the hour nothing is written and the cookie isn't reset.
	set(guest.GuestID, `expires_at=expires_at-interval '30 minutes'`)
	before := idle(guest.GuestID)
	if _, cookies := read(cookie, 200); len(cookies) != 0 || !idle(guest.GuestID).Equal(before) {
		t.Fatal("extension wrote within the hour")
	}
	// Cart use extends too.
	set(guest.GuestID, `expires_at=clock_timestamp()+interval '1 day'`)
	if r := api.request(t, "GET", "/api/v1/guest/cart", "", "", cookie, false, 200); len(r.cookies) != 1 || !within(idle(guest.GuestID), 7*24*time.Hour) {
		t.Fatal("cart read did not extend the session")
	}
	// Never past the absolute deadline.
	set(guest.GuestID, `expires_at=clock_timestamp()+interval '1 hour',absolute_expires_at=clock_timestamp()+interval '3 hours'`)
	view, cookies = read(cookie, 200)
	if !within(view.ExpiresAt, 3*time.Hour) || len(cookies) != 1 || !within(cookies[0].Expires, 3*time.Hour) || !within(idle(guest.GuestID), 3*time.Hour) {
		t.Fatalf("absolute bound: view=%+v cookies=%v", view, cookies)
	}
	// An idle-expired session is unavailable, and use can't revive it.
	set(guest.GuestID, `created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second'`)
	read(cookie, 401)
	api.request(t, "GET", "/api/v1/guest/cart", "", "", cookie, false, 401)

	// A session from the previous release (no absolute deadline) keeps its
	// fixed expiry, and rotation carries that expiry as the absolute one.
	legacy, legacyCookie := createGuest(t, api)
	set(legacy.GuestID, `absolute_expires_at=NULL,expires_at=clock_timestamp()+interval '2 days'`)
	fixed := idle(legacy.GuestID)
	view, cookies = read(legacyCookie, 200)
	if len(cookies) != 0 || !view.ExpiresAt.Equal(fixed) || !idle(legacy.GuestID).Equal(fixed) {
		t.Fatalf("legacy session moved: view=%+v", view)
	}
	rotated := api.request(t, "POST", "/api/v1/guest/session/rotate", "", "", legacyCookie, true, 200)
	var absolute time.Time
	if err := f.migrator.QueryRow(f.ctx, `SELECT expires_at,absolute_expires_at FROM guest_sessions WHERE guest_id=$1 AND revoked_at IS NULL`, legacy.GuestID).Scan(&before, &absolute); err != nil || !before.Equal(fixed) || !absolute.Equal(fixed) || len(rotated.cookies) != 1 || !within(rotated.cookies[0].Expires, 2*24*time.Hour) {
		t.Fatalf("legacy rotation: idle=%v absolute=%v err=%v", before, absolute, err)
	}
}
