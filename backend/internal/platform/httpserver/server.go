package httpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

func New(address string, ready func(context.Context) error, logger *slog.Logger, mount ...func(chi.Router)) *http.Server {
	router := chi.NewRouter()
	router.Use(observe(logger))

	router.Get("/health/live", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	router.Get("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if err := ready(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "not_ready", "Service is not ready")
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	for _, routes := range mount {
		routes(router)
	}

	router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "Resource not found")
	})

	router.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method not allowed")
	})

	return &http.Server{
		Addr: address, Handler: router,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second,
	}
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	_ = json.NewEncoder(w).Encode(struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{code, message})
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *responseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func observe(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var id [16]byte
			if _, err := rand.Read(id[:]); err != nil {
				writeError(w, http.StatusInternalServerError, "internal_error", "Request could not be processed")
				return
			}
			requestID := hex.EncodeToString(id[:])
			w.Header().Set("X-Request-ID", requestID)
			r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
			wrapped := &responseWriter{ResponseWriter: w}
			start := time.Now()
			defer func() {
				if recover() != nil {
					logger.Error("request panic", "request_id", requestID)
					if wrapped.status == 0 {
						writeError(wrapped, http.StatusInternalServerError, "internal_error", "Request could not be processed")
					}
				}
				status := wrapped.status
				if status == 0 {
					status = http.StatusOK
				}
				// Never log raw URLs, query strings, credentials, or request bodies.
				logger.Info("http request", "request_id", requestID, "method", r.Method, "status", status, "duration_ms", time.Since(start).Milliseconds())
			}()
			next.ServeHTTP(wrapped, r)
		})
	}
}
