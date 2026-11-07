package config

import (
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"

	"ecom/backend/internal/platform/email"
)

type Config struct {
	Environment    string
	HTTPAddress    string
	DatabaseURL    string
	JWTSecret      []byte
	FrontendOrigin string
	Mail           email.Config
	// TLSCertFile and TLSKeyFile are both set or both empty. The files are
	// loaded by the HTTP server at startup, not here.
	TLSCertFile string
	TLSKeyFile  string
	// StaticDir is an optional built frontend served from the API origin.
	// The HTTP server checks it at startup.
	StaticDir string
}

// TLSEnabled reports whether the API serves HTTPS.
func (c Config) TLSEnabled() bool {
	return c.TLSCertFile != ""
}

// SecureCookies reports whether session and guest cookies carry Secure.
func (c Config) SecureCookies() bool {
	return c.Environment == "production" || c.TLSEnabled()
}

// HSTS reports whether responses carry Strict-Transport-Security. It is
// never sent from local mode, where it would pin every localhost port to HTTPS.
func (c Config) HSTS() bool {
	return c.Environment == "production" && c.TLSEnabled()
}

// Load reads explicit process configuration; it never reads files or logs secrets.
func Load(getenv func(string) string) (Config, error) {
	c := Config{
		Environment: getenv("APP_ENV"),
		HTTPAddress: getenv("HTTP_ADDR"),
		DatabaseURL: getenv("DATABASE_URL"),
		TLSCertFile: getenv("TLS_CERT_FILE"),
		TLSKeyFile:  getenv("TLS_KEY_FILE"),
		StaticDir:   getenv("STATIC_DIR"),
	}

	if c.Environment != "local" && c.Environment != "production" {
		return Config{}, errors.New("APP_ENV must be local or production")
	}

	if c.HTTPAddress == "" {
		c.HTTPAddress = "127.0.0.1:8080"
	}

	host, port, err := net.SplitHostPort(c.HTTPAddress)
	portNumber, portError := strconv.Atoi(port)
	if err != nil || portError != nil || portNumber < 1 || portNumber > 65535 {
		return Config{}, errors.New("HTTP_ADDR must contain a host and port")
	}

	if c.Environment == "local" && host != "localhost" && !net.ParseIP(host).IsLoopback() {
		return Config{}, errors.New("local HTTP_ADDR must bind to loopback")
	}

	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return Config{}, errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be set together")
	}

	if c.Environment == "production" && !c.TLSEnabled() {
		return Config{}, errors.New("production requires TLS_CERT_FILE and TLS_KEY_FILE")
	}

	if err := ValidateDatabase(c.Environment, c.DatabaseURL); err != nil {
		return Config{}, err
	}

	secret, err := base64.StdEncoding.Strict().DecodeString(getenv("JWT_SECRET_BASE64"))
	if err != nil || len(secret) < 32 {
		return Config{}, errors.New("JWT_SECRET_BASE64 must encode at least 32 random bytes")
	}

	c.JWTSecret = secret
	c.FrontendOrigin = getenv("FRONTEND_ORIGIN")

	if c.FrontendOrigin == "" && c.Environment == "local" {
		c.FrontendOrigin = "http://localhost:5173"
	}

	origin, originError := url.Parse(c.FrontendOrigin)
	if originError != nil || origin == nil || origin.Hostname() == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || c.FrontendOrigin != origin.Scheme+"://"+origin.Host || (origin.Scheme != "http" && origin.Scheme != "https") {
		return Config{}, errors.New("FRONTEND_ORIGIN must be an explicit HTTP(S) origin without credentials or a path")
	}

	if c.Environment == "production" && origin.Scheme != "https" {
		return Config{}, errors.New("production FRONTEND_ORIGIN requires HTTPS")
	}

	if c.Environment == "local" && origin.Scheme == "http" && origin.Hostname() != "localhost" && !net.ParseIP(origin.Hostname()).IsLoopback() {
		return Config{}, errors.New("insecure local FRONTEND_ORIGIN must be loopback")
	}

	c.Mail = email.Config{Mode: getenv("MAIL_MODE"), Host: getenv("SMTP_HOST"), Port: getenv("SMTP_PORT"), TLSMode: getenv("SMTP_TLS_MODE"), Username: getenv("SMTP_USERNAME"), Password: getenv("SMTP_PASSWORD"), From: getenv("MAIL_FROM")}
	if err := email.Validate(c.Mail); err != nil {
		return Config{}, err
	}

	if c.Environment == "production" && c.Mail.Mode != "smtp" {
		return Config{}, errors.New("production requires MAIL_MODE=smtp")
	}

	return c, nil
}

// ValidateDatabase shares the API's explicit environment/TLS policy with the
// operator command, without requiring unrelated HTTP or authentication settings.
func ValidateDatabase(environment, connectionURL string) error {
	if environment != "local" && environment != "production" {
		return errors.New("APP_ENV must be local or production")
	}

	u, err := url.Parse(connectionURL)
	if err != nil || u == nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Hostname() == "" || strings.Trim(u.Path, "/") == "" || u.User == nil {
		return errors.New("DATABASE_URL must be an explicit PostgreSQL URL")
	}

	password, present := u.User.Password()
	if !present || password == "" || u.User.Username() == "" {
		return errors.New("DATABASE_URL requires explicit credentials")
	}

	mode := u.Query().Get("sslmode")
	localDB := u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback()

	if mode != "verify-full" && !(environment == "local" && localDB && mode == "disable") {
		return errors.New("DATABASE_URL requires sslmode=verify-full, except explicit local loopback connections")
	}

	if u.Query().Has("host") || u.Query().Has("hostaddr") || u.Query().Has("service") {
		return errors.New("DATABASE_URL must not override connection hosts or services")
	}

	return nil
}
