package httpserver

import (
	"crypto/tls"
	"fmt"
	"net/http"
)

// HSTSValue is sent only in production with TLS (see config.HSTS).
const HSTSValue = "max-age=31536000"

// EnableTLS loads the certificate and key pair into server so it can serve
// HTTPS with ListenAndServeTLS("", ""). It fails at startup, before
// listening, when either file is unreadable or the pair does not match.
func EnableTLS(server *http.Server, certFile, keyFile string) error {
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE could not be loaded as a key pair: %w", err)
	}
	server.TLSConfig = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{pair},
	}
	return nil
}

// HSTS adds Strict-Transport-Security to every response.
func HSTS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Strict-Transport-Security", HSTSValue)
		next.ServeHTTP(w, r)
	})
}
