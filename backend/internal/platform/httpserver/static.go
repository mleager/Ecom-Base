package httpserver

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
)

// Cache policies for the built frontend.
const (
	cacheRevalidate = "no-cache"
	cacheImmutable  = "public, max-age=31536000, immutable"
	cacheFixture    = "public, max-age=3600"
)

// Static serves a built frontend directory (STATIC_DIR). The directory is
// opened as an os.Root, so neither ".." nor symbolic links can reach files
// outside it. It fails when the directory has no regular index.html.
func Static(dir string) (http.Handler, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, errors.New("STATIC_DIR must be a readable directory")
	}
	return newStatic(root.FS())
}

func newStatic(fsys fs.FS) (http.Handler, error) {
	info, err := fs.Stat(fsys, "index.html")
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("STATIC_DIR must contain index.html")
	}
	return &staticHandler{fsys: fsys}, nil
}

type staticHandler struct {
	fsys fs.FS
}

// ServeHTTP serves an existing file, or index.html for extensionless paths so
// that client-side routes and email links work on direct navigation. Missing
// files with an extension get a plain 404. Callers pass only GET and HEAD.
func (s *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Cleaning a rooted path removes every ".." segment.
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") {
			http.NotFound(w, r)
			return
		}
	}

	if s.serveFile(w, r, name) {
		return
	}
	if path.Ext(name) != "" || !s.serveFile(w, r, "index.html") {
		http.NotFound(w, r)
	}
}

func (s *staticHandler) serveFile(w http.ResponseWriter, r *http.Request, name string) bool {
	if !fs.ValidPath(name) {
		return false
	}
	file, err := s.fsys.Open(name)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}

	content, ok := file.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(file)
		if err != nil {
			return false
		}
		content = bytes.NewReader(data)
	}

	header := w.Header()
	switch {
	case strings.HasSuffix(name, ".html"):
		header.Set("Cache-Control", cacheRevalidate)
		header.Set("Referrer-Policy", "no-referrer")
		header.Set("X-Frame-Options", "DENY")
	case strings.HasPrefix(name, "assets/"):
		header.Set("Cache-Control", cacheImmutable)
	case strings.HasPrefix(name, "fixtures/v1/"):
		header.Set("Cache-Control", cacheFixture)
	default:
		header.Set("Cache-Control", cacheRevalidate)
	}
	http.ServeContent(w, r, name, info.ModTime(), content)
	return true
}

// isServerPath reports whether a path belongs to the API or operational
// routes. Unknown paths there keep the JSON 404 and never reach the SPA.
func isServerPath(p string) bool {
	return p == "/api" || strings.HasPrefix(p, "/api/") ||
		p == "/health" || strings.HasPrefix(p, "/health/") ||
		p == "/metrics" || strings.HasPrefix(p, "/metrics/")
}

// SPA mounts static as the fallback after every API and operational route.
// Pass it as the last mount to New.
func SPA(static http.Handler) func(chi.Router) {
	return func(router chi.Router) {
		router.NotFound(func(w http.ResponseWriter, r *http.Request) {
			if (r.Method != http.MethodGet && r.Method != http.MethodHead) || isServerPath(r.URL.Path) {
				notFound(w, r)
				return
			}
			static.ServeHTTP(w, r)
		})
	}
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "not_found", "Resource not found")
}
