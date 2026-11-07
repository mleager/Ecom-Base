package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	valid := map[string]string{
		"APP_ENV": "local", "DATABASE_URL": "postgresql://ecom_app:private@127.0.0.1:5432/ecom?sslmode=disable",
		"JWT_SECRET_BASE64": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32))),
	}
	cases := []struct {
		name, key, value string
		wantError        bool
	}{
		{"valid", "APP_ENV", "local", false},
		{"unknown environment", "APP_ENV", "staging", true},
		{"missing environment", "APP_ENV", "", true},
		{"short secret", "JWT_SECRET_BASE64", "eA==", true},
		{"malformed secret", "JWT_SECRET_BASE64", "not-base64", true},
		{"missing URL", "DATABASE_URL", "", true},
		{"other scheme", "DATABASE_URL", "mysql://user:private@localhost/ecom", true},
		{"missing password", "DATABASE_URL", "postgres://ecom_app@localhost/ecom?sslmode=disable", true},
		{"implicit SSL", "DATABASE_URL", "postgres://user:private@localhost/ecom", true},
		{"remote insecure", "DATABASE_URL", "postgres://user:private@db.example/ecom?sslmode=disable", true},
		{"unverified TLS", "DATABASE_URL", "postgres://user:private@db.example/ecom?sslmode=require", true},
		{"verified TLS", "DATABASE_URL", "postgres://user:private@db.example/ecom?sslmode=verify-full", false},
		{"host override", "DATABASE_URL", "postgres://user:private@localhost/ecom?sslmode=disable&host=remote", true},
		{"public local listener", "HTTP_ADDR", "0.0.0.0:8080", true},
		{"invalid port", "HTTP_ADDR", "localhost:not-a-port", true},
		{"port overflow", "HTTP_ADDR", "localhost:65536", true},
		{"IPv6 loopback", "HTTP_ADDR", "[::1]:8080", false},
		{"origin with path", "FRONTEND_ORIGIN", "http://localhost:5173/path", true},
		{"origin empty query", "FRONTEND_ORIGIN", "http://localhost:5173?", true},
		{"origin wildcard", "FRONTEND_ORIGIN", "*", true},
		{"origin credentials", "FRONTEND_ORIGIN", "https://user:secret@example.com", true},
		{"origin nonlocal HTTP", "FRONTEND_ORIGIN", "http://example.com", true},
		{"origin exact local", "FRONTEND_ORIGIN", "http://localhost:5174", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) string {
				if key == tc.key {
					return tc.value
				}
				return valid[key]
			}
			c, err := Load(getenv)
			if (err != nil) != tc.wantError {
				t.Fatalf("Load error = %v, want error %v", err, tc.wantError)
			}
			if err != nil && strings.Contains(err.Error(), "private") {
				t.Fatal("configuration error disclosed a credential")
			}
			if err == nil && (len(c.JWTSecret) != 32 || c.HTTPAddress == "") {
				t.Fatal("valid configuration omitted required defaults")
			}
		})
	}
}

func TestProductionOrigin(t *testing.T) {
	for _, origin := range []string{"", "http://shop.example.com", "https://shop.example.com"} {
		values := map[string]string{
			"MAIL_MODE": "smtp", "SMTP_HOST": "smtp.example.com", "SMTP_PORT": "465", "SMTP_TLS_MODE": "tls", "SMTP_USERNAME": "test", "SMTP_PASSWORD": "test", "MAIL_FROM": "accounts@example.com",
			"TLS_CERT_FILE": "server.pem", "TLS_KEY_FILE": "server.key",
			"APP_ENV": "production", "DATABASE_URL": "postgres://app:private@db.example.com/ecom?sslmode=verify-full",
			"JWT_SECRET_BASE64": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32))), "FRONTEND_ORIGIN": origin,
		}
		_, err := Load(func(key string) string { return values[key] })
		if (err == nil) != (origin == "https://shop.example.com") {
			t.Fatal("production origin must be explicit and HTTPS")
		}
	}
}

func TestTLSSettings(t *testing.T) {
	production := map[string]string{
		"APP_ENV": "production", "DATABASE_URL": "postgres://app:private@db.example.com/ecom?sslmode=verify-full",
		"FRONTEND_ORIGIN": "https://shop.example.com",
		"MAIL_MODE":       "smtp", "SMTP_HOST": "smtp.example.com", "SMTP_PORT": "465", "SMTP_TLS_MODE": "tls", "SMTP_USERNAME": "test", "SMTP_PASSWORD": "test", "MAIL_FROM": "accounts@example.com",
	}
	local := map[string]string{
		"APP_ENV": "local", "DATABASE_URL": "postgresql://ecom_app:private@127.0.0.1:5432/ecom?sslmode=disable",
	}
	cases := []struct {
		name                          string
		base                          map[string]string
		cert, key                     string
		wantError                     bool
		wantTLS, wantSecure, wantHSTS bool
	}{
		{"local HTTP", local, "", "", false, false, false, false},
		{"local HTTPS", local, "server.pem", "server.key", false, true, true, false},
		{"local cert only", local, "server.pem", "", true, false, false, false},
		{"local key only", local, "", "server.key", true, false, false, false},
		{"production without TLS", production, "", "", true, false, false, false},
		{"production cert only", production, "server.pem", "", true, false, false, false},
		{"production key only", production, "", "server.key", true, false, false, false},
		{"production HTTPS", production, "server.pem", "server.key", false, true, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]string{
				"JWT_SECRET_BASE64": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32))),
				"TLS_CERT_FILE":     tc.cert, "TLS_KEY_FILE": tc.key,
			}
			for key, value := range tc.base {
				values[key] = value
			}
			c, err := Load(func(key string) string { return values[key] })
			if (err != nil) != tc.wantError {
				t.Fatalf("Load error = %v, want error %v", err, tc.wantError)
			}
			if err != nil {
				if !strings.Contains(err.Error(), "TLS_") || strings.Contains(err.Error(), "private") {
					t.Fatalf("unclear or disclosing TLS error: %v", err)
				}
				return
			}
			if c.TLSEnabled() != tc.wantTLS || c.SecureCookies() != tc.wantSecure || c.HSTS() != tc.wantHSTS {
				t.Fatalf("TLS=%v Secure=%v HSTS=%v, want %v %v %v", c.TLSEnabled(), c.SecureCookies(), c.HSTS(), tc.wantTLS, tc.wantSecure, tc.wantHSTS)
			}
			if c.TLSCertFile != tc.cert || c.TLSKeyFile != tc.key {
				t.Fatal("TLS file paths were not kept")
			}
		})
	}
}
