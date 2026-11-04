package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	AccessLifetime  = 15 * time.Minute
	SessionLifetime = 7 * 24 * time.Hour
)

type accessClaims struct {
	SessionID string `json:"sid"`
	jwt.RegisteredClaims
}

func newID() (pgtype.UUID, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return pgtype.UUID{}, err
	}

	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80

	return pgtype.UUID{Bytes: id, Valid: true}, nil
}

func idString(id pgtype.UUID) string {
	b := id.Bytes
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func parseID(value string) (pgtype.UUID, error) {
	var id pgtype.UUID
	if err := id.Scan(value); err != nil || !id.Valid || id.Bytes[6]>>4 != 4 || id.Bytes[8]>>6 != 2 || idString(id) != value {
		return pgtype.UUID{}, ErrUnauthorized
	}

	return id, nil
}

func refreshToken() (string, error) {
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(secret[:]), nil
}

func tokenDigest(raw string) (string, error) {
	if len(raw) != 43 {
		return "", ErrUnauthorized
	}

	decoded, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != raw {
		return "", ErrUnauthorized
	}

	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:]), nil
}

func (s *Service) signAccess(userID, sessionID pgtype.UUID) (string, error) {
	jti, err := newID()
	if err != nil {
		return "", err
	}

	now := s.now().UTC().Truncate(time.Second)

	claims := accessClaims{
		SessionID: idString(sessionID),
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: "ecom", Subject: idString(userID), Audience: jwt.ClaimStrings{"ecom-api"}, ID: idString(jti),
			IssuedAt: jwt.NewNumericDate(now), NotBefore: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(AccessLifetime)),
		},
	}

	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

func (s *Service) parseAccess(raw string) (pgtype.UUID, pgtype.UUID, error) {
	if len(raw) > 4096 {
		return pgtype.UUID{}, pgtype.UUID{}, ErrUnauthorized
	}

	claims := &accessClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 || token.Header["typ"] != "JWT" || len(token.Header) != 2 {
			return nil, ErrUnauthorized
		}
		return s.secret, nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("ecom"), jwt.WithAudience("ecom-api"),
		jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithStrictDecoding(), jwt.WithLeeway(30*time.Second), jwt.WithTimeFunc(s.now))

	if err != nil || !token.Valid || claims.IssuedAt == nil || claims.NotBefore == nil || claims.ExpiresAt == nil {
		return pgtype.UUID{}, pgtype.UUID{}, ErrUnauthorized
	}

	lifetime := claims.ExpiresAt.Sub(claims.IssuedAt.Time)
	if lifetime <= 0 || lifetime > AccessLifetime || claims.NotBefore.After(claims.ExpiresAt.Time) {
		return pgtype.UUID{}, pgtype.UUID{}, ErrUnauthorized
	}

	userID, userError := parseID(claims.Subject)
	sessionID, sessionError := parseID(claims.SessionID)

	_, jtiError := parseID(claims.ID)
	if userError != nil || sessionError != nil || jtiError != nil {
		return pgtype.UUID{}, pgtype.UUID{}, ErrUnauthorized
	}

	return userID, sessionID, nil
}
