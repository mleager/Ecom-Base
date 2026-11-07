//go:build integration

package integration

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"
)

// TestDatabaseTLS is opt-in: run it with bash scripts/dev.sh database-tls-check
// against a container started by bash scripts/dev.sh database-tls.
func TestDatabaseTLS(t *testing.T) {
	if os.Getenv("ECOM_DB_TLS") != "1" {
		t.Skip("requires the TLS database; run bash scripts/dev.sh database-tls-check")
	}
	plain, err := url.Parse(os.Getenv("ECOM_TEST_TLS_URL"))
	caFile := os.Getenv("ECOM_TEST_DB_CA")
	if err != nil || plain.Host == "" || caFile == "" {
		t.Fatal("ECOM_TEST_TLS_URL and ECOM_TEST_DB_CA must be set explicitly")
	}

	// withTLS returns the URL with sslmode=verify-full, the given CA and host.
	withTLS := func(host, rootCert string) string {
		u := *plain
		u.Host = host + ":" + plain.Port()
		q := u.Query()
		q.Set("sslmode", "verify-full")
		if rootCert != "" {
			q.Set("sslrootcert", rootCert)
		} else {
			q.Del("sslrootcert")
		}
		u.RawQuery = q.Encode()
		return u.String()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// sslInUse reports whether the session is encrypted, from the server's view.
	sslInUse := func(t *testing.T, conn *pgx.Conn) (bool, string) {
		t.Helper()
		var ssl bool
		var version *string
		if err := conn.QueryRow(ctx, "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()").Scan(&ssl, &version); err != nil {
			t.Fatalf("read pg_stat_ssl: %v", redact(err, plain))
		}
		if version == nil {
			return ssl, ""
		}
		return ssl, *version
	}

	t.Run("verify-full with the local CA", func(t *testing.T) {
		for _, host := range []string{"localhost", "127.0.0.1"} {
			connectionURL := withTLS(host, caFile)
			if err := config.ValidateDatabase("production", connectionURL); err != nil {
				t.Fatalf("%s: production policy rejected the URL: %v", host, err)
			}
			conn, err := pgx.Connect(ctx, connectionURL)
			if err != nil {
				t.Fatalf("%s: connect: %v", host, redact(err, plain))
			}
			ssl, version := sslInUse(t, conn)
			_ = conn.Close(ctx)
			if !ssl || (version != "TLSv1.2" && version != "TLSv1.3") {
				t.Fatalf("%s: ssl=%v version=%q", host, ssl, version)
			}
		}
	})

	t.Run("the API pool connects over TLS", func(t *testing.T) {
		pool, err := database.Open(ctx, withTLS("localhost", caFile))
		if err != nil {
			t.Fatal(err)
		}
		defer pool.Close()
		var ssl bool
		if err := pool.QueryRow(ctx, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").Scan(&ssl); err != nil || !ssl {
			t.Fatalf("pool session ssl=%v err=%v", ssl, redact(err, plain))
		}
	})

	t.Run("a wrong host name is refused", func(t *testing.T) {
		cfg, err := pgx.ParseConfig(withTLS("127.0.0.1", caFile))
		if err != nil {
			t.Fatal(redact(err, plain))
		}
		// Dial the real server but verify the certificate against another name.
		cfg.TLSConfig.ServerName = "wrong.example"
		conn, err := pgx.ConnectConfig(ctx, cfg)
		if err == nil {
			_ = conn.Close(ctx)
			t.Fatal("connected although the certificate does not name the host")
		}
		var hostnameError x509.HostnameError
		if !errors.As(err, &hostnameError) {
			t.Fatalf("want a host name error, got: %v", redact(err, plain))
		}
	})

	t.Run("an untrusted CA is refused", func(t *testing.T) {
		otherCA := writeOtherCA(t)
		for name, rootCert := range map[string]string{"other CA": otherCA, "system roots": ""} {
			conn, err := pgx.Connect(ctx, withTLS("localhost", rootCert))
			if err == nil {
				_ = conn.Close(ctx)
				t.Fatalf("%s: connected with an untrusted certificate", name)
			}
			var unknownAuthority x509.UnknownAuthorityError
			if !errors.As(err, &unknownAuthority) {
				t.Fatalf("%s: want an unknown-authority error, got: %v", name, redact(err, plain))
			}
		}
	})

	t.Run("sslmode=disable still works for the default flow", func(t *testing.T) {
		conn, err := pgx.Connect(ctx, plain.String())
		if err != nil {
			t.Fatal(redact(err, plain))
		}
		defer conn.Close(ctx)
		if ssl, _ := sslInUse(t, conn); ssl {
			t.Fatal("sslmode=disable session reported TLS")
		}
	})
}

// writeOtherCA writes an unrelated self-signed CA certificate.
func writeOtherCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Untrusted test CA"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "other-ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// redact removes the connection password from driver errors before logging.
func redact(err error, u *url.URL) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	if password, ok := u.User.Password(); ok && password != "" {
		message = strings.ReplaceAll(message, password, "REDACTED")
		message = strings.ReplaceAll(message, url.QueryEscape(password), "REDACTED")
	}
	return errors.New(message)
}
