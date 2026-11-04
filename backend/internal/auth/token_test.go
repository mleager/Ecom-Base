package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestAccessTokens(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	service := &Service{secret: []byte(strings.Repeat("k", 32)), now: func() time.Time { return now }}
	user, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	session, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := service.signAccess(user, session)
	if err != nil {
		t.Fatal(err)
	}
	gotUser, gotSession, err := service.parseAccess(raw)
	if err != nil || gotUser != user || gotSession != session {
		t.Fatal("valid access token failed")
	}
	for _, change := range []string{"issuer", "audience", "expiry", "future issuance", "future validity", "lifetime", "subject", "session", "jti", "missing iat", "missing nbf", "missing exp", "missing jti", "type", "key URL", "signature", "algorithm", "unsigned"} {
		t.Run(change, func(t *testing.T) {
			claims := jwt.MapClaims{"iss": "ecom", "aud": "ecom-api", "sub": idString(user), "sid": idString(session), "jti": idString(user), "iat": now.Unix(), "nbf": now.Unix(), "exp": now.Add(AccessLifetime).Unix()}
			method := jwt.SigningMethod(jwt.SigningMethodHS256)
			key := any(service.secret)
			switch change {
			case "issuer":
				claims["iss"] = "another issuer"
			case "audience":
				claims["aud"] = "another API"
			case "expiry":
				claims["iat"], claims["nbf"], claims["exp"] = now.Add(-17*time.Minute).Unix(), now.Add(-17*time.Minute).Unix(), now.Add(-2*time.Minute).Unix()
			case "future issuance":
				claims["iat"] = now.Add(time.Minute).Unix()
			case "future validity":
				claims["nbf"] = now.Add(time.Minute).Unix()
			case "lifetime":
				claims["exp"] = now.Add(time.Hour).Unix()
			case "subject":
				claims["sub"] = "invalid"
			case "session":
				delete(claims, "sid")
			case "jti":
				claims["jti"] = "invalid"
			case "missing iat", "missing nbf", "missing exp", "missing jti":
				delete(claims, strings.TrimPrefix(change, "missing "))
			case "signature":
				key = []byte(strings.Repeat("z", 32))
			case "algorithm":
				method = jwt.SigningMethodHS384
			case "unsigned":
				method, key = jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType
			case "type", "key URL":
				// Header-specific mutations follow token creation.
			}
			token := jwt.NewWithClaims(method, claims)
			if change == "type" {
				token.Header["typ"] = "other"
			}
			if change == "key URL" {
				token.Header["jku"] = "https://untrusted.example/key"
			}
			raw, err := token.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := service.parseAccess(raw); err == nil {
				t.Fatal("accepted invalid token")
			}
		})
	}
	if _, _, err := service.parseAccess(strings.Repeat("x", 4097)); err == nil {
		t.Fatal("accepted oversized token")
	}
}

func TestRefreshTokenEncoding(t *testing.T) {
	first, err := refreshToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := refreshToken()
	if err != nil || first == second {
		t.Fatal("refresh token entropy failed")
	}
	digest, err := tokenDigest(first)
	if err != nil || len(digest) != 64 || strings.Contains(digest, first) {
		t.Fatal("invalid verifier")
	}
	for _, raw := range []string{"", first + "=", first[:42], strings.Repeat("!", 43)} {
		if _, err := tokenDigest(raw); err == nil {
			t.Fatal("accepted malformed refresh token")
		}
	}
}
