package httpserver

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
)

const indexHTML = "<!doctype html><title>shop</title>"

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":              {Data: []byte(indexHTML)},
		"assets/index-abc123.js":  {Data: []byte("console.log(1)")},
		"assets/index-abc123.css": {Data: []byte("body{}")},
		"assets/.hidden.js":       {Data: []byte("hidden")},
		"fixtures/v1/lamp.svg":    {Data: []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")},
		"robots.txt":              {Data: []byte("User-agent: *")},
		".env":                    {Data: []byte("SECRET=private")},
	}
}

// apiRoutes stands in for the auth and commerce mounts: an /api/v1 subrouter
// plus the root-level /metrics route.
func apiRoutes(router chi.Router) {
	router.Group(func(r chi.Router) {
		r.Route("/api/v1", func(api chi.Router) {
			api.Get("/products", func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "products") })
			api.Post("/auth/logout", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
		})
		r.Get("/metrics", func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "metrics") })
	})
}

func spaServer(t *testing.T) http.Handler {
	t.Helper()
	static, err := newStatic(testFS())
	if err != nil {
		t.Fatal(err)
	}
	return New("127.0.0.1:8080", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(io.Discard, nil)), apiRoutes, SPA(static)).Handler
}

func TestStaticRequiresIndex(t *testing.T) {
	for name, fsys := range map[string]fstest.MapFS{
		"missing":   {"assets/app.js": {Data: []byte("x")}},
		"directory": {"index.html/inner": {Data: []byte("x")}},
	} {
		if _, err := newStatic(fsys); err == nil || !strings.Contains(err.Error(), "index.html") {
			t.Fatalf("%s index.html: error = %v", name, err)
		}
	}
	if _, err := Static(filepath.Join(t.TempDir(), "absent")); err == nil || !strings.Contains(err.Error(), "STATIC_DIR") {
		t.Fatalf("missing directory: error = %v", err)
	}
}

func TestSPARouteMatrix(t *testing.T) {
	handler := spaServer(t)
	type want struct {
		status       int
		body         string // exact body, or "" to skip
		contentType  string // prefix
		cacheControl string
		html         bool // HTML security headers expected
	}
	index := want{http.StatusOK, indexHTML, "text/html", "no-cache", true}
	jsonNotFound := want{http.StatusNotFound, "", "application/json", "", false}
	plainNotFound := want{http.StatusNotFound, "", "text/plain", "", false}

	cases := []struct {
		method, path string
		want         want
	}{
		// Every route family and email-link page falls back to index.html.
		{"GET", "/", index},
		{"GET", "/index.html", index},
		{"GET", "/products/0b6f1c1e-7a7e-4f6e-9a55-2b8a9f7f9c01", index},
		{"GET", "/login", index},
		{"GET", "/signup", index},
		{"GET", "/forgot-password", index},
		{"GET", "/cart", index},
		{"GET", "/cart/", index},
		{"GET", "/checkout", index},
		{"GET", "/orders/0b6f1c1e-7a7e-4f6e-9a55-2b8a9f7f9c01", index},
		{"GET", "/account/addresses/new", index},
		{"GET", "/account/security", index},
		{"GET", "/admin/products/0b6f1c1e-7a7e-4f6e-9a55-2b8a9f7f9c01/inventory", index},
		{"GET", "/guest/orders", index},
		{"GET", "/guest/checkout/0b6f1c1e-7a7e-4f6e-9a55-2b8a9f7f9c01", index},
		{"GET", "/verify-email", index},
		{"GET", "/confirm-email-change", index},
		{"GET", "/reset-password", index},
		{"GET", "/guest/recover", index},
		{"GET", "/unknown/page", index},
		{"GET", "/assets", index}, // directories are never listed
		{"GET", "/products?page=2", index},

		// Real files and their cache policies.
		{"GET", "/assets/index-abc123.js", want{http.StatusOK, "console.log(1)", "text/javascript", "public, max-age=31536000, immutable", false}},
		{"GET", "/assets/index-abc123.css", want{http.StatusOK, "body{}", "text/css", "public, max-age=31536000, immutable", false}},
		{"GET", "/fixtures/v1/lamp.svg", want{http.StatusOK, "", "image/svg+xml", "public, max-age=3600", false}},
		{"GET", "/robots.txt", want{http.StatusOK, "User-agent: *", "text/plain", "no-cache", false}},

		// Missing files, dotfiles and traversal get a plain 404.
		{"GET", "/assets/missing-abc.js", plainNotFound},
		{"GET", "/favicon.ico", plainNotFound},
		{"GET", "/.env", plainNotFound},
		{"GET", "/assets/.hidden.js", plainNotFound},
		{"GET", "/.git/config", plainNotFound},
		{"GET", "/assets/../.env", plainNotFound},
		{"GET", "/%2e%2e/%2e%2e/etc/hosts.txt", plainNotFound},
		// Traversal resolves inside the root; an extensionless result is a page.
		{"GET", "/%2e%2e/%2e%2e/etc/passwd", index},

		// API and operational routes behave as before.
		{"GET", "/api/v1/products", want{http.StatusOK, "products", "", "", false}},
		{"POST", "/api/v1/auth/logout", want{http.StatusNoContent, "", "", "", false}},
		{"GET", "/metrics", want{http.StatusOK, "metrics", "", "", false}},
		{"GET", "/health/live", want{http.StatusOK, "", "", "", false}},
		{"GET", "/api/v1/unknown", jsonNotFound},
		{"GET", "/api/v1/unknown.js", jsonNotFound},
		{"GET", "/api", jsonNotFound},
		{"GET", "/api/v2/products", jsonNotFound},
		{"GET", "/health/unknown", jsonNotFound},
		{"GET", "/metrics/extra", jsonNotFound},
		{"POST", "/health/live", want{http.StatusMethodNotAllowed, "", "application/json", "", false}},
		{"DELETE", "/api/v1/products", want{http.StatusMethodNotAllowed, "", "application/json", "", false}},

		// The fallback covers only GET and HEAD.
		{"POST", "/cart", jsonNotFound},
		{"PUT", "/", jsonNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
			h := w.Header()
			if w.Code != tc.want.status {
				t.Fatalf("status %d, want %d (body %q)", w.Code, tc.want.status, w.Body.String())
			}
			if tc.want.body != "" && w.Body.String() != tc.want.body {
				t.Fatalf("body %q, want %q", w.Body.String(), tc.want.body)
			}
			if !strings.HasPrefix(h.Get("Content-Type"), tc.want.contentType) {
				t.Fatalf("Content-Type %q, want prefix %q", h.Get("Content-Type"), tc.want.contentType)
			}
			if tc.want.cacheControl != "" && h.Get("Cache-Control") != tc.want.cacheControl {
				t.Fatalf("Cache-Control %q, want %q", h.Get("Cache-Control"), tc.want.cacheControl)
			}
			html := h.Get("Referrer-Policy") == "no-referrer" && h.Get("X-Frame-Options") == "DENY" && h.Get("X-Content-Type-Options") == "nosniff"
			if html != tc.want.html {
				t.Fatalf("HTML security headers present = %v, want %v", html, tc.want.html)
			}
			if strings.Contains(w.Body.String(), "private") || strings.Contains(w.Body.String(), "hidden") {
				t.Fatal("served a dotfile")
			}
			if len(h.Get("X-Request-ID")) != 32 {
				t.Fatal("response bypassed the request middleware")
			}
		})
	}
}

func TestSPAHead(t *testing.T) {
	handler := spaServer(t)
	for _, p := range []string{"/orders", "/assets/index-abc123.js"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodHead, p, nil))
		if w.Code != http.StatusOK || w.Body.Len() != 0 || w.Header().Get("Content-Length") == "" || w.Header().Get("Cache-Control") == "" {
			t.Fatalf("HEAD %s: status %d, body %d bytes, headers %v", p, w.Code, w.Body.Len(), w.Header())
		}
	}
}

func TestWithoutStaticUnchanged(t *testing.T) {
	handler := New("127.0.0.1:8080", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(io.Discard, nil)), apiRoutes).Handler
	for _, p := range []string{"/", "/cart", "/assets/index-abc123.js", "/api/v1/unknown"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
		if w.Code != http.StatusNotFound || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("%s: status %d, Content-Type %q", p, w.Code, w.Header().Get("Content-Type"))
		}
	}
}

// TestStaticStaysInsideRoot uses a real directory: a sibling file and a
// symbolic link pointing out of STATIC_DIR must not be served.
func TestStaticStaysInsideRoot(t *testing.T) {
	base := t.TempDir()
	dist := filepath.Join(base, "dist")
	if err := os.Mkdir(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		filepath.Join(base, "outside.txt"): "private outside",
		filepath.Join(dist, "index.html"):  indexHTML,
		filepath.Join(dist, "inside.txt"):  "inside",
	} {
		if err := os.WriteFile(name, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(base, "outside.txt"), filepath.Join(dist, "link.txt")); err != nil {
		t.Fatal(err)
	}
	static, err := Static(dist)
	if err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]int{
		"/inside.txt":               http.StatusOK,
		"/link.txt":                 http.StatusNotFound,
		"/../outside.txt":           http.StatusNotFound,
		"/%2e%2e/outside.txt":       http.StatusNotFound,
		"/assets/../../outside.txt": http.StatusNotFound,
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.URL.Path = strings.ReplaceAll(p, "%2e", ".")
		static.ServeHTTP(w, r)
		if w.Code != want || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("%s: status %d, want %d", p, w.Code, want)
		}
	}
}
