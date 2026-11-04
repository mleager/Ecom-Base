package auth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

func TestPasswords(t *testing.T) {
	p, err := newPasswords()
	if err != nil {
		t.Fatal(err)
	}
	password := "  a long preserved passphrase  "
	first, err := p.hash(context.Background(), password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := p.hash(context.Background(), password)
	if err != nil || first == second {
		t.Fatal("password salts are not unique")
	}
	for _, tc := range []struct {
		password, verifier string
		match              bool
	}{
		{password, first, true},
		{strings.TrimSpace(password), first, false},
		{password, "invalid verifier", false},
	} {
		matched, upgrade, err := p.verify(context.Background(), tc.password, tc.verifier)
		if err != nil || matched != tc.match || upgrade {
			t.Fatalf("unexpected verification result: match=%v, upgrade=%v, error=%v", matched, upgrade, err)
		}
	}
	salt := []byte("0123456789abcdef")
	legacyKey := argon2.IDKey([]byte(password), salt, 2, 19*1024, 1, 32)
	legacy := fmt.Sprintf("$argon2id$v=19$m=19456,t=2,p=1$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(legacyKey))
	matched, upgrade, err := p.verify(context.Background(), password, legacy)
	if err != nil || !matched || !upgrade {
		t.Fatal("valid legacy verifier was not marked for rehash")
	}
	p.slots <- struct{}{}
	p.slots <- struct{}{}
	if _, err := p.hash(context.Background(), password); !errors.Is(err, ErrCapacity) {
		t.Fatal("hash work is not bounded")
	}
	if _, _, err := p.verify(context.Background(), password, first); !errors.Is(err, ErrCapacity) {
		t.Fatal("verification work is not bounded")
	}
	<-p.slots
	<-p.slots
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.hash(cancelled, password); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled work started hashing")
	}
}

func TestPasswordInputAndVerifierBounds(t *testing.T) {
	for _, tc := range []struct {
		password string
		valid    bool
	}{
		{strings.Repeat("x", 14), false}, {strings.Repeat("x", 15), true},
		{strings.Repeat("x", 129), false}, {strings.Repeat("😀", 128), true},
		{string([]byte{0xff}) + strings.Repeat("x", 15), false},
	} {
		if validPassword(tc.password) != tc.valid {
			t.Fatal("incorrect password input boundary")
		}
	}
	valid := "$argon2id$v=19$m=65536,t=3,p=1$" + base64.RawStdEncoding.EncodeToString(make([]byte, 16)) + "$" + base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	if _, err := parsePassword(valid); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		strings.Replace(valid, "65536", "4294967295", 1), strings.Replace(valid, "t=3", "t=999", 1),
		strings.Replace(valid, "p=1", "p=0", 1), strings.Replace(valid, "v=19", "v=18", 1),
		strings.Replace(valid, "m=65536,t=3,p=1", "m=65536,p=1,t=3", 1),
		strings.Replace(valid, "p=1", "p=1junk", 1), strings.Replace(valid, "m=65536", "m=065536", 1),
		valid + "garbage", strings.Repeat("x", 1000),
	} {
		if _, err := parsePassword(invalid); err == nil {
			t.Fatal("accepted malformed or unbounded verifier")
		}
	}
}

func BenchmarkPasswordHash(b *testing.B) {
	p := &passwords{slots: make(chan struct{}, 2)}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := p.hash(context.Background(), "a long benchmark passphrase"); err != nil {
			b.Fatal(err)
		}
	}
}
