//go:build integration

package fixturecmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type browserControl struct {
	Fixture string `json:"fixture"`
	Action  string `json:"action"`
	Account string `json:"account"`
}

func parseBrowserControl(raw string) (browserControl, error) {
	var input browserControl
	if len(raw) > 512 {
		return input, errors.New("browser control input is too large")
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !namePattern.MatchString(input.Fixture) || decoder.Decode(new(any)) != io.EOF {
		return input, errors.New("browser control input is invalid")
	}
	switch input.Action {
	case "expire-session", "deactivate", "session-expiry":
		if input.Account != "customer_one" && input.Account != "admin" {
			return input, errors.New("browser control account is invalid")
		}
	case "near-cart-version-limit":
		if input.Account != "customer_one" {
			return input, errors.New("browser control account is invalid")
		}
	case "demote":
		if input.Account != "admin" {
			return input, errors.New("browser control account is invalid")
		}
	default:
		return input, errors.New("browser control action is invalid")
	}
	return input, nil
}

func TestBrowserControlInput(t *testing.T) {
	valid := `{"fixture":"ecom_fixture_0123456789abcdef","action":"expire-session","account":"customer_one"}`
	if _, err := parseBrowserControl(valid); err != nil {
		t.Fatal("valid browser control rejected")
	}
	nearLimit := strings.Replace(valid, "expire-session", "near-cart-version-limit", 1)
	if _, err := parseBrowserControl(nearLimit); err != nil {
		t.Fatal("bounded cart version control rejected")
	}
	for _, action := range []string{"expire-session", "deactivate", "session-expiry"} {
		admin := strings.Replace(strings.Replace(valid, "expire-session", action, 1), "customer_one", "admin", 1)
		if _, err := parseBrowserControl(admin); err != nil {
			t.Fatal("bounded administrator session control rejected")
		}
	}
	for _, raw := range []string{
		strings.Replace(valid, "ecom_fixture_0123456789abcdef", "ecom", 1),
		strings.Replace(valid, "expire-session", "arbitrary-sql", 1),
		strings.Replace(valid, "customer_one", "customer_two", 1),
		strings.Replace(valid, "expire-session", "demote", 1),
		strings.Replace(nearLimit, "customer_one", "customer_two", 1),
		strings.Replace(nearLimit, "customer_one", "admin", 1),
		strings.TrimSuffix(valid, "}") + `,"sql":"SELECT 1"}`,
		valid + `{}`, strings.Repeat("x", 513), "null",
	} {
		if _, err := parseBrowserControl(raw); err == nil {
			t.Fatal("unsafe browser control accepted")
		}
	}
}

// Playwright invokes this compiled test directly. It is absent from production
// binaries/CLI routes and skips ordinary Go runs without explicit harness input.
func TestBrowserAuthControl(t *testing.T) {
	raw := os.Getenv("ECOM_BROWSER_CONTROL")
	if raw == "" {
		t.Skip("only invoked by the owned browser fixture harness")
	}
	input, err := parseBrowserControl(raw)
	if err != nil {
		t.Fatal("browser control input rejected")
	}
	root, err := os.Getwd()
	if err != nil {
		t.Fatal("browser control workspace unavailable")
	}
	source, err := credentials(os.Getenv)
	if err != nil {
		t.Fatal("browser control requires explicit local fixture credentials")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	metadata, err := inspectOrRemove(ctx, root, input.Fixture, false, source)
	if err != nil {
		t.Fatal("browser control fixture ownership/configuration check failed")
	}
	dir, err := directory(root, input.Fixture)
	if err != nil {
		t.Fatal("browser control fixture directory rejected")
	}
	var bundle Bundle
	if readJSON(filepath.Join(dir, "bundle.json"), &bundle) != nil || bundle.Metadata != metadata {
		t.Fatal("browser control bundle rejected")
	}
	account, exists := bundle.Accounts[input.Account]
	if !exists {
		t.Fatal("browser control account missing")
	}
	target := *source
	target.Path, target.RawPath = "/"+metadata.Name, ""
	conn, err := connect(ctx, target.String())
	if err != nil {
		t.Fatal("browser control fixture connection failed")
	}
	defer conn.Close(context.Background())
	// Recheck the ownership marker on the actual target connection before writes.
	if exists, err := owned(ctx, conn, metadata); err != nil || !exists {
		t.Fatal("browser control target ownership rejected")
	}
	result := map[string]any{"ok": true}
	var query string
	switch input.Action {
	case "expire-session":
		query = `UPDATE user_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL`
	case "deactivate":
		query = `UPDATE users SET is_active=false WHERE id=$1`
	case "demote":
		query = `UPDATE users SET role='customer' WHERE id=$1`
	case "near-cart-version-limit":
		query = `UPDATE carts SET version=9007199254740990 WHERE user_id=$1 AND version<9007199254740990`
	case "session-expiry":
		var expires time.Time
		var lifetime float64
		if err := conn.QueryRow(ctx, `SELECT expires_at,extract(epoch FROM expires_at-created_at) FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL`, account.ID).Scan(&expires, &lifetime); err != nil {
			t.Fatal("browser control session read failed")
		}
		result["expires_at"], result["lifetime_seconds"] = expires.UTC().Format(time.RFC3339Nano), lifetime
	default:
		t.Fatal("browser control action rejected")
	}
	if query != "" {
		tag, err := conn.Exec(ctx, query, account.ID)
		if err != nil || tag.RowsAffected() != 1 {
			t.Fatal("browser control expected exactly one fixture row")
		}
	}
	// Only non-secret result metadata crosses this process boundary.
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		t.Fatal("browser control result encoding failed")
	}
}
