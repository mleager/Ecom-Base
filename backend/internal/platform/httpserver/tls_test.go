package httpserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeKeyPair writes a self-signed localhost certificate and its key to dir.
func writeKeyPair(t *testing.T, dir, name string) (certFile, keyFile string, cert *x509.Certificate) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err = x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certFile = filepath.Join(dir, name+".pem")
	keyFile = filepath.Join(dir, name+".key")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile, cert
}

func TestEnableTLSServesHTTPS(t *testing.T) {
	certFile, keyFile, cert := writeKeyPair(t, t.TempDir(), "server")
	server := New("127.0.0.1:0", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err := EnableTLS(server, certFile, keyFile); err != nil {
		t.Fatalf("EnableTLS: %v", err)
	}
	if server.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Fatal("minimum TLS version is not 1.2")
	}
	server.ErrorLog = log.New(io.Discard, "", 0) // the rejected handshakes below are expected

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- server.ServeTLS(listener, "", "") }()
	t.Cleanup(func() {
		_ = server.Close()
		if err := <-served; !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("ServeTLS: %v", err)
		}
	})

	roots := x509.NewCertPool()
	roots.AddCert(cert)
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	url := "https://localhost:" + port + "/health/live"

	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}}
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("HTTPS request: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || response.TLS == nil || response.TLS.Version < tls.VersionTLS12 {
		t.Fatalf("status %d over %+v", response.StatusCode, response.TLS)
	}
	if response.Header.Get("Strict-Transport-Security") != "" {
		t.Fatal("HSTS sent without the HSTS wrapper")
	}

	old := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MaxVersion: tls.VersionTLS11}}}
	if response, err := old.Get(url); err == nil {
		_ = response.Body.Close()
		t.Fatal("TLS 1.1 client was accepted")
	}

	untrusting := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool()}}}
	if response, err := untrusting.Get(url); err == nil {
		_ = response.Body.Close()
		t.Fatal("client without the CA accepted the certificate")
	}
}

func TestEnableTLSRejectsBadFiles(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile, _ := writeKeyPair(t, dir, "server")
	_, otherKey, _ := writeKeyPair(t, dir, "other")
	for _, tc := range []struct{ name, cert, key string }{
		{"missing certificate", filepath.Join(dir, "absent.pem"), keyFile},
		{"missing key", certFile, filepath.Join(dir, "absent.key")},
		{"mismatched key", certFile, otherKey},
		{"swapped files", keyFile, certFile},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := &http.Server{}
			err := EnableTLS(server, tc.cert, tc.key)
			if err == nil || !strings.Contains(err.Error(), "TLS_CERT_FILE and TLS_KEY_FILE") {
				t.Fatalf("EnableTLS error = %v", err)
			}
			if server.TLSConfig != nil {
				t.Fatal("TLS configured despite the error")
			}
		})
	}
}

func TestHSTS(t *testing.T) {
	server := New("127.0.0.1:8080", func(context.Context) error { return nil }, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	handler := HSTS(server.Handler)
	for _, path := range []string{"/health/live", "/api/v1/unknown"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Header().Get("Strict-Transport-Security") != "max-age=31536000" {
			t.Fatalf("%s: missing HSTS header", path)
		}
	}
}
