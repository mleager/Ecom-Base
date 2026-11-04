package email_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/testmail"
)

func TestSMTPTransport(t *testing.T) {
	for _, tc := range []struct {
		name    string
		options testmail.Options
		trusted bool
		fail    bool
	}{
		{"implicit TLS", testmail.Options{Mode: "tls"}, true, false},
		{"required STARTTLS", testmail.Options{Mode: "starttls"}, true, false},
		{"untrusted certificate", testmail.Options{Mode: "tls"}, false, true},
		{"no downgrade", testmail.Options{Mode: "starttls", NoSTARTTLS: true}, true, true},
		{"authentication failure", testmail.Options{RejectAuth: true}, true, true},
		{"lost DATA acknowledgement", testmail.Options{DropAck: true}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			peer, err := testmail.Start(tc.options)
			if err != nil {
				t.Fatal("peer startup failed")
			}
			defer peer.Close()
			var sender email.Sender
			if tc.trusted {
				sender, err = peer.Sender()
			} else {
				sender, err = email.New(peer.Config)
			}
			if err != nil {
				t.Fatal("transport construction failed")
			}
			err = sender.Send(context.Background(), []email.Message{{To: "customer@example.test", Subject: "Security notice", Body: "Private UTF-8: café\nline two"}})
			if (err != nil) != tc.fail {
				t.Fatal("unexpected delivery outcome")
			}
			messages := peer.Messages("customer@example.test")
			if !tc.fail && (len(messages) != 1 || !strings.Contains(messages[0].Body, "café")) {
				t.Fatal("message encoding failed")
			}
			if tc.options.DropAck && len(messages) != 1 {
				t.Fatal("ambiguous delivery must not retry")
			}
		})
	}
}

func TestSMTPBoundsAndHeaders(t *testing.T) {
	peer, err := testmail.Start(testmail.Options{NoUTF8: true})
	if err != nil {
		t.Fatal("peer failed")
	}
	defer peer.Close()
	sender, _ := peer.Sender()
	for _, batch := range [][]email.Message{nil, {{To: "a@example.test\r\nBcc: victim@example.test", Subject: "test"}}, {{To: "a@example.test", Subject: "test\r\nBcc: victim@example.test"}}, {{To: "a@example.test", Subject: "test", Body: strings.Repeat("x", 16385)}}, {{To: "é@example.test", Subject: "test"}}, {{}, {}, {}}} {
		if sender.Send(context.Background(), batch) == nil {
			t.Fatal("unsafe message accepted")
		}
	}
	if len(peer.Messages("a@example.test")) != 0 {
		t.Fatal("invalid input sent mail")
	}
}

func TestSMTPDeadlineAndCapacity(t *testing.T) {
	peer, err := testmail.Start(testmail.Options{Stall: true})
	if err != nil {
		t.Fatal("peer failed")
	}
	defer peer.Close()
	sender, _ := peer.Sender()
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = sender.Send(context.Background(), []email.Message{{To: "a@example.test", Subject: "test"}})
		}()
	}
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	if sender.Send(context.Background(), []email.Message{{To: "a@example.test", Subject: "test"}}) == nil || time.Since(start) > time.Second {
		t.Fatal("capacity limit did not reject promptly")
	}
	wg.Wait()
	if time.Since(start) > 3*time.Second {
		t.Fatal("SMTP exceeded bounded deadline")
	}
}

func TestSMTPConfig(t *testing.T) {
	valid := email.Config{Mode: "smtp", Host: "smtp.example.test", Port: "465", TLSMode: "tls", Username: "user", Password: "private", From: "accounts@example.test"}
	for _, change := range []func(*email.Config){func(c *email.Config) { c.Mode = "disabled" }, func(c *email.Config) { c.TLSMode = "none" }, func(c *email.Config) { c.Port = "0" }, func(c *email.Config) { c.Host = "smtp://host" }, func(c *email.Config) { c.From = "Name <accounts@example.test>" }, func(c *email.Config) { c.Password = "" }, func(c *email.Config) { c.Username = "bad\r\n" }} {
		c := valid
		change(&c)
		if email.Validate(c) == nil {
			t.Fatal("invalid SMTP configuration accepted")
		}
	}
	if email.Validate(valid) != nil || email.Validate(email.Config{Mode: "disabled"}) != nil {
		t.Fatal("valid configuration rejected")
	}
}
