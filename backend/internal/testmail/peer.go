// Package testmail provides an ephemeral TLS SMTP peer for tests. Production
// commands do not import it. Mail and credentials remain in process memory.
package testmail

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"io"
	"math/big"
	"net"
	"net/mail"
	"net/textproto"
	"strings"
	"sync"
	"time"

	"ecom/backend/internal/platform/email"
)

type Options struct {
	Mode                                           string
	NoSTARTTLS, RejectAuth, NoUTF8, DropAck, Stall bool
}

type Peer struct {
	Config      email.Config
	Roots       *x509.CertPool
	listener    net.Listener
	tls         *tls.Config
	options     Options
	mu          sync.Mutex
	messages    []email.Message
	connections map[net.Conn]bool
	closed      bool
	wg          sync.WaitGroup
}

func Start(options Options) (*Peer, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "isolated SMTP"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}

	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}

	roots := x509.NewCertPool()
	roots.AddCert(cert)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}

	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		listener.Close()
		return nil, err
	}

	_, port, _ := net.SplitHostPort(listener.Addr().String())

	if options.Mode == "" {
		options.Mode = "tls"
	}

	p := &Peer{
		Config: email.Config{
			Mode:     "smtp",
			Host:     "127.0.0.1",
			Port:     port,
			TLSMode:  options.Mode,
			Username: "isolated",
			Password: base64.RawURLEncoding.EncodeToString(secret[:]),
			From:     "accounts@example.test",
		},
		Roots:    roots,
		listener: listener,
		tls: &tls.Config{
			MinVersion: tls.VersionTLS12,
			Certificates: []tls.Certificate{{
				Certificate: [][]byte{der},
				PrivateKey:  key,
			}},
		},
		options:     options,
		connections: make(map[net.Conn]bool),
	}

	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				conn.Close()
				return
			}
			p.connections[conn] = true
			p.wg.Add(1)
			p.mu.Unlock()
			go p.serve(conn)
		}
	}()

	return p, nil
}

func (p *Peer) Close() {
	p.mu.Lock()
	p.closed = true
	p.listener.Close()
	for conn := range p.connections {
		conn.Close()
	}
	p.mu.Unlock()
	p.wg.Wait()
}

func (p *Peer) Messages(to string) []email.Message {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := []email.Message{}
	for _, m := range p.messages {
		if m.To == to {
			result = append(result, m)
		}
	}
	return result
}
func (p *Peer) SetDropAck(value bool) { p.mu.Lock(); p.options.DropAck = value; p.mu.Unlock() }

func (p *Peer) serve(raw net.Conn) {
	defer p.wg.Done()
	defer raw.Close()
	defer func() { p.mu.Lock(); delete(p.connections, raw); p.mu.Unlock() }()
	_ = raw.SetDeadline(time.Now().Add(5 * time.Second))
	var conn net.Conn = raw
	secure := false
	if p.options.Stall {
		_, _ = io.Copy(io.Discard, raw)
		return
	}
	if p.options.Mode == "tls" {
		tlsConn := tls.Server(raw, p.tls)
		if tlsConn.Handshake() != nil {
			return
		}
		conn = tlsConn
		secure = true
	}
	reader := textproto.NewReader(bufio.NewReader(conn))
	writer := bufio.NewWriter(conn)
	send := func(line string) bool {
		_, err := writer.WriteString(line + "\r\n")
		if err != nil {
			return false
		}
		return writer.Flush() == nil
	}
	if !send("220 isolated ESMTP") {
		return
	}
	authed := false
	to := ""
	for {
		line, err := reader.ReadLine()
		if err != nil || len(line) > 2048 {
			return
		}
		command, argument, _ := strings.Cut(line, " ")
		switch command {
		case "EHLO":
			if !send("250-isolated") {
				return
			}
			if !secure && !p.options.NoSTARTTLS {
				if !send("250-STARTTLS") {
					return
				}
			}
			if !p.options.NoUTF8 {
				if !send("250-SMTPUTF8") {
					return
				}
			}
			if !send("250 AUTH PLAIN") {
				return
			}
		case "HELO":
			if !send("250 isolated") {
				return
			}
		case "STARTTLS":
			if secure || p.options.NoSTARTTLS {
				send("454 TLS unavailable")
				return
			}
			if !send("220 begin TLS") {
				return
			}
			tlsConn := tls.Server(raw, p.tls)
			if tlsConn.Handshake() != nil {
				return
			}
			conn = tlsConn
			secure = true
			reader = textproto.NewReader(bufio.NewReader(conn))
			writer = bufio.NewWriter(conn)
		case "AUTH":
			payload := strings.TrimPrefix(argument, "PLAIN ")
			decoded, e := base64.StdEncoding.DecodeString(payload)
			if !secure || e != nil || string(decoded) != "\x00"+p.Config.Username+"\x00"+p.Config.Password || p.options.RejectAuth {
				send("535 authentication rejected")
				return
			}
			authed = true
			if !send("235 authenticated") {
				return
			}
		case "MAIL":
			if !authed {
				send("530 authentication required")
				return
			}
			to = ""
			if !send("250 sender ok") {
				return
			}
		case "RCPT":
			to = strings.TrimSuffix(strings.TrimPrefix(argument, "TO:<"), ">")
			if to == "" {
				return
			}
			if !send("250 recipient ok") {
				return
			}
		case "DATA":
			if !authed || to == "" {
				return
			}
			if !send("354 message") {
				return
			}
			data, e := io.ReadAll(io.LimitReader(reader.DotReader(), 16385))
			if e != nil || len(data) > 16384 {
				return
			}
			message, e := mail.ReadMessage(strings.NewReader(string(data)))
			if e != nil {
				return
			}
			body, e := io.ReadAll(base64.NewDecoder(base64.StdEncoding, message.Body))
			if e != nil {
				return
			}
			p.mu.Lock()
			if len(p.messages) < 100 {
				p.messages = append(p.messages, email.Message{To: to, Subject: message.Header.Get("Subject"), Body: string(body)})
			}
			drop := p.options.DropAck
			p.mu.Unlock()
			if drop {
				return
			}
			if !send("250 accepted") {
				return
			}
		case "QUIT":
			send("221 closing")
			return
		case "RSET":
			to = ""
			if !send("250 reset") {
				return
			}
		default:
			send("500 unsupported command")
			return
		}
	}
}

func (p *Peer) Sender() (email.Sender, error) {
	if p == nil {
		return nil, errors.New("SMTP peer unavailable")
	}
	return email.NewWithTLSRoots(p.Config, p.Roots)
}
