package email

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrDelivery = errors.New("email delivery unconfirmed")

type Config struct {
	Mode     string
	Host     string
	Port     string
	TLSMode  string
	Username string
	Password string
	From     string
}

type Message struct {
	To      string
	Subject string
	Body    string
}

type Sender interface {
	Enabled() bool
	Send(context.Context, []Message) error
}

type Disabled struct{}

func (Disabled) Enabled() bool {
	return false
}

func (Disabled) Send(context.Context, []Message) error {
	return ErrDelivery
}

func ascii(value string) bool {
	for _, r := range value {
		if r < 32 || r > 126 {
			return false
		}
	}
	return true
}

func Validate(c Config) error {
	if c.Mode == "" || c.Mode == "disabled" {
		if c.Host != "" || c.Port != "" || c.TLSMode != "" || c.Username != "" || c.Password != "" || c.From != "" {
			return errors.New("SMTP settings require MAIL_MODE=smtp")
		}
		return nil
	}

	if c.Mode != "smtp" {
		return errors.New("MAIL_MODE must be disabled or smtp")
	}

	port, err := strconv.Atoi(c.Port)
	if err != nil || port < 1 || port > 65535 || c.Host == "" || !ascii(c.Host) || strings.ContainsAny(c.Host, " /\\@?#\r\n\t") || (strings.Contains(c.Host, ":") && net.ParseIP(c.Host) == nil) {
		return errors.New("SMTP_HOST and SMTP_PORT must specify an explicit host and port")
	}

	if c.TLSMode != "starttls" && c.TLSMode != "tls" {
		return errors.New("SMTP_TLS_MODE must be starttls or tls")
	}

	if c.Username == "" || c.Password == "" || strings.ContainsAny(c.Username+c.Password, "\r\n\x00") {
		return errors.New("SMTP credentials must be explicit and contain no control separators")
	}

	from, err := mail.ParseAddress(c.From)
	if err != nil || from.Address != c.From || len(c.From) > 254 || !ascii(c.From) || strings.ContainsAny(c.From, "\r\n") {
		return errors.New("MAIL_FROM must be a single ASCII mailbox without a display name")
	}

	return nil
}

type transport struct {
	config Config
	roots  *x509.CertPool
	slots  chan struct{}
}

func New(c Config) (Sender, error) {
	return NewWithTLSRoots(c, nil)
}

// NewWithTLSRoots - Roots are dependency injection for isolated tests. The application always
// calls New and has no environment switch for custom trust.
func NewWithTLSRoots(c Config, roots *x509.CertPool) (Sender, error) {
	if err := Validate(c); err != nil {
		return nil, err
	}

	if c.Mode != "smtp" {
		return Disabled{}, nil
	}

	return &transport{
		config: c,
		roots:  roots,
		slots:  make(chan struct{}, 2),
	}, nil
}

func (t *transport) Enabled() bool {
	return true
}

func (t *transport) Send(ctx context.Context, batch []Message) error {
	if len(batch) < 1 || len(batch) > 2 {
		return ErrDelivery
	}

	encoded := make([][]byte, len(batch))
	for i, m := range batch {
		to, err := mail.ParseAddress(m.To)
		if err != nil || to.Address != m.To || len(m.To) > 254 || strings.ContainsAny(m.To, "\r\n\x00") || !utf8.ValidString(m.To) || m.Subject == "" || len(m.Subject) > 200 || !ascii(m.Subject) || strings.ContainsAny(m.Subject, "\r\n") || len(m.Body) > 12*1024 || !utf8.ValidString(m.Body) {
			return ErrDelivery
		}

		body := base64.StdEncoding.EncodeToString([]byte(m.Body))
		var lines strings.Builder
		for len(body) > 76 {
			lines.WriteString(body[:76] + "\r\n")
			body = body[76:]
		}

		lines.WriteString(body + "\r\n")
		var messageID [16]byte
		if _, err := rand.Read(messageID[:]); err != nil {
			return ErrDelivery
		}

		domain := t.config.From[strings.LastIndex(t.config.From, "@")+1:]
		data := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%x@%s>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n%s", t.config.From, m.To, m.Subject, time.Now().UTC().Format(time.RFC1123Z), messageID, domain, lines.String())
		if len(data) > 16*1024 {
			return ErrDelivery
		}

		encoded[i] = []byte(data)
	}

	select {
	case t.slots <- struct{}{}:
		defer func() { <-t.slots }()
	default:
		return ErrDelivery
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(t.config.Host, t.config.Port))
	if err != nil {
		return ErrDelivery
	}
	defer conn.Close()

	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	deadline, _ := ctx.Deadline()
	if conn.SetDeadline(deadline) != nil {
		return ErrDelivery
	}

	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: t.config.Host,
		RootCAs:    t.roots,
	}

	var client *smtp.Client
	if t.config.TLSMode == "tls" {
		secure := tls.Client(conn, tlsConfig)
		if secure.HandshakeContext(ctx) != nil {
			return ErrDelivery
		}
		client, err = smtp.NewClient(secure, t.config.Host)
	} else {
		client, err = smtp.NewClient(conn, t.config.Host)
	}
	if err != nil {
		return ErrDelivery
	}
	defer client.Close()

	if t.config.TLSMode == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return ErrDelivery
		}
		if client.StartTLS(tlsConfig) != nil {
			return ErrDelivery
		}
	}

	if client.Auth(smtp.PlainAuth("", t.config.Username, t.config.Password, t.config.Host)) != nil {
		return ErrDelivery
	}

	for i, m := range batch {
		if !ascii(m.To) {
			if ok, _ := client.Extension("SMTPUTF8"); !ok {
				return ErrDelivery
			}
		}
		if client.Mail(t.config.From) != nil || client.Rcpt(m.To) != nil {
			return ErrDelivery
		}
		writer, err := client.Data()
		if err != nil {
			return ErrDelivery
		}
		if _, err = writer.Write(encoded[i]); err != nil {
			return ErrDelivery
		}
		if writer.Close() != nil {
			return ErrDelivery
		}
	}

	// DATA acknowledgement is acceptance; a failed QUIT cannot undo it.
	_ = client.Quit()
	return nil
}
