package auth

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	db "ecom/backend/internal/db/sqlc"
	"ecom/backend/internal/platform/email"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidInput = errors.New("invalid authentication input")
	ErrUnauthorized = errors.New("authentication required")
	ErrConflict     = errors.New("account already exists")
	ErrCapacity     = errors.New("authentication capacity exceeded")
	// ErrRefreshReused is an ErrUnauthorized that also revoked the session:
	// a rotated refresh token came back after the grace period.
	ErrRefreshReused = fmt.Errorf("%w: rotated refresh token reused", ErrUnauthorized)
)

// RefreshReuseGrace is how long after a rotation the previous refresh token
// gets only a 401 (two tabs refreshing at once). It is also in the
// LockRotatedRefreshSession query.
const RefreshReuseGrace = 30 * time.Second

type User struct {
	ID            string    `json:"id"`
	FirstName     string    `json:"first_name"`
	LastName      string    `json:"last_name"`
	Email         string    `json:"email"`
	Role          string    `json:"role"`
	CreatedAt     time.Time `json:"created_at"`
	EmailVerified bool      `json:"email_verified"`
}

type Registration struct {
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Email     string `json:"email"`
	Password  string `json:"password"`
}

type Credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type Tokens struct {
	AccessToken string    `json:"access_token"`
	TokenType   string    `json:"token_type"`
	ExpiresIn   int       `json:"expires_in"`
	Refresh     string    `json:"-"`
	ExpiresAt   time.Time `json:"-"`
}

type Service struct {
	pool       *pgxpool.Pool
	queries    *db.Queries
	passwords  *passwords
	secret     []byte
	now        func() time.Time
	mailer     email.Sender
	mailOrigin string
}

type SecurityOptions struct {
	Sender email.Sender
	Origin string
}

func NewService(pool *pgxpool.Pool, secret []byte, now func() time.Time, options ...SecurityOptions) (*Service, error) {
	if pool == nil || len(secret) < 32 || now == nil {
		return nil, errors.New("invalid authentication service configuration")
	}

	passwords, err := newPasswords()
	if err != nil {
		return nil, errors.New("could not initialize password verification")
	}

	service := &Service{
		pool:      pool,
		queries:   db.New(pool),
		passwords: passwords,
		secret:    append([]byte(nil), secret...),
		now:       now,
		mailer:    email.Disabled{},
	}

	if len(options) > 1 {
		return nil, errors.New("invalid security options")
	}
	if len(options) == 1 {
		if options[0].Sender == nil {
			return nil, errors.New("security sender is required")
		}

		o, err := url.Parse(options[0].Origin)
		if err != nil || o.Hostname() == "" || o.User != nil || o.Path != "" || o.RawQuery != "" || o.Fragment != "" || options[0].Origin != o.Scheme+"://"+o.Host || (o.Scheme != "https" && !(o.Scheme == "http" && (o.Hostname() == "localhost" || net.ParseIP(o.Hostname()).IsLoopback()))) {
			return nil, errors.New("security origin must be HTTPS or local loopback")
		}

		service.mailer = options[0].Sender
		service.mailOrigin = options[0].Origin
	}

	return service, nil
}

func canonicalEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func validEmail(email string) bool {
	parsed, err := mail.ParseAddress(email)
	return utf8.ValidString(email) && len(email) <= 254 && err == nil && parsed.Address == email
}

// NormalizeContactEmail applies the same mailbox grammar as account registration.
func NormalizeContactEmail(email string) (string, bool) {
	email = canonicalEmail(email)
	return email, validEmail(email)
}

func validName(name string) bool {
	return utf8.ValidString(name) && !strings.ContainsRune(name, 0) && utf8.RuneCountInString(name) > 0 && utf8.RuneCountInString(name) <= 200
}

func (s *Service) Register(ctx context.Context, input Registration) (User, error) {
	input.Email = canonicalEmail(input.Email)
	input.FirstName = strings.TrimSpace(input.FirstName)
	input.LastName = strings.TrimSpace(input.LastName)

	if !validEmail(input.Email) || !validName(input.FirstName) || !validName(input.LastName) || !validPassword(input.Password) {
		return User{}, ErrInvalidInput
	}

	hash, err := s.passwords.hash(ctx, input.Password)
	if err != nil {
		return User{}, err
	}

	userID, err := newID()
	if err != nil {
		return User{}, err
	}

	cartID, err := newID()
	if err != nil {
		return User{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, err
	}

	defer func() { _ = tx.Rollback(ctx) }()

	queries := s.queries.WithTx(tx)
	user, err := queries.CreateCustomer(
		ctx, db.CreateCustomerParams{
			ID:           userID,
			FirstName:    input.FirstName,
			LastName:     input.LastName,
			Email:        input.Email,
			PasswordHash: hash,
		},
	)
	if err != nil {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) && pgError.Code == "23505" && pgError.ConstraintName == "users_email_key" {
			return User{}, ErrConflict
		}
		return User{}, err
	}

	if err := queries.CreateCustomerCart(ctx, db.CreateCustomerCartParams{ID: cartID, UserID: userID}); err != nil {
		return User{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return User{}, err
	}

	return userView(user), nil
}

func (s *Service) Login(ctx context.Context, input Credentials) (Tokens, error) {
	input.Email = canonicalEmail(input.Email)
	if !validEmail(input.Email) || !validPassword(input.Password) {
		return Tokens{}, ErrInvalidInput
	}

	user, err := s.queries.FindUserByEmail(ctx, input.Email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Tokens{}, err
	}

	matched, upgrade, verifyError := s.passwords.verify(ctx, input.Password, user.PasswordHash)
	if verifyError != nil {
		return Tokens{}, verifyError
	}

	if !matched || !user.IsActive {
		return Tokens{}, ErrUnauthorized
	}

	var upgraded string
	if upgrade {
		upgraded, err = s.passwords.hash(ctx, input.Password)
		if err != nil {
			return Tokens{}, err
		}
	}

	id, err := newID()
	if err != nil {
		return Tokens{}, err
	}

	refresh, err := refreshToken()
	if err != nil {
		return Tokens{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tokens{}, err
	}

	defer func() { _ = tx.Rollback(ctx) }()

	queries := s.queries.WithTx(tx)
	current, err := queries.LockUser(ctx, user.ID)
	if err != nil {
		return Tokens{}, err
	}

	if !current.IsActive || current.PasswordHash != user.PasswordHash || current.CredentialVersion != user.CredentialVersion || current.Email != input.Email {
		return Tokens{}, ErrUnauthorized
	}

	if upgraded != "" {
		if err := queries.RehashPassword(ctx, db.RehashPasswordParams{ID: user.ID, PasswordHash: upgraded}); err != nil {
			return Tokens{}, err
		}
	}

	verifier, _ := tokenDigest(refresh)
	session, err := queries.CreateSession(ctx, db.CreateSessionParams{ID: id, UserID: user.ID, RefreshTokenHash: verifier})
	if err != nil {
		return Tokens{}, err
	}

	tokens, err := s.issue(user.ID, id, refresh, session.ExpiresAt.Time.UTC())
	if err != nil {
		return Tokens{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Tokens{}, err
	}

	return tokens, nil
}

func (s *Service) issue(userID, sessionID pgtype.UUID, refresh string, expires time.Time) (Tokens, error) {
	access, err := s.signAccess(userID, sessionID)
	if err != nil {
		return Tokens{}, err
	}

	return Tokens{
		AccessToken: access,
		TokenType:   "Bearer",
		ExpiresIn:   int(AccessLifetime.Seconds()),
		Refresh:     refresh,
		ExpiresAt:   expires,
	}, nil
}

func (s *Service) Refresh(ctx context.Context, raw string) (Tokens, error) {
	verifier, err := tokenDigest(raw)
	if err != nil {
		return Tokens{}, ErrUnauthorized
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Tokens{}, err
	}

	defer func() { _ = tx.Rollback(ctx) }()

	queries := s.queries.WithTx(tx)
	// Discover ownership without locking, then use the same user-first order as
	// login and credential revocation. Revalidate the verifier after the lock.
	located, err := queries.FindRefreshSession(ctx, verifier)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tokens{}, rotatedRefresh(ctx, tx, queries, verifier)
	}

	if err != nil {
		return Tokens{}, err
	}

	user, err := queries.LockUser(ctx, located.UserID)
	if err != nil {
		return Tokens{}, err
	}

	if !user.IsActive {
		return Tokens{}, ErrUnauthorized
	}

	session, err := queries.LockRefreshSession(ctx, verifier)
	if errors.Is(err, pgx.ErrNoRows) {
		return Tokens{}, ErrUnauthorized
	}
	if err != nil {
		return Tokens{}, err
	}
	active, err := queries.SessionIsActive(ctx, db.SessionIsActiveParams{SessionID: session.ID, UserID: user.ID})
	if err != nil {
		return Tokens{}, err
	}
	if !active {
		return Tokens{}, ErrUnauthorized
	}

	refresh, err := refreshToken()
	if err != nil {
		return Tokens{}, err
	}

	tokens, err := s.issue(user.ID, session.ID, refresh, session.ExpiresAt.Time)
	if err != nil {
		return Tokens{}, err
	}

	verifier, _ = tokenDigest(tokens.Refresh)
	changed, err := queries.RotateRefreshSession(ctx, db.RotateRefreshSessionParams{ID: session.ID, RefreshTokenHash: verifier})
	if err != nil {
		return Tokens{}, err
	}

	if changed != 1 {
		return Tokens{}, ErrUnauthorized
	}

	if err := tx.Commit(ctx); err != nil {
		return Tokens{}, err
	}

	return tokens, nil
}

// rotatedRefresh handles a refresh token that is not current. If it is the
// one a live session replaced, reuse within RefreshReuseGrace is a race
// between tabs and gets ErrUnauthorized only; later reuse means the token
// was copied, so the session is revoked for every holder (ErrRefreshReused).
// Only the latest replaced token is kept: an older one gets ErrUnauthorized.
func rotatedRefresh(ctx context.Context, tx pgx.Tx, queries *db.Queries, verifier string) error {
	previous := pgtype.Text{String: verifier, Valid: true}
	located, err := queries.FindRotatedRefreshSession(ctx, previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}

	// Same user-first lock order as refresh, login and revocation.
	if _, err := queries.LockUser(ctx, located.UserID); err != nil {
		return err
	}
	session, err := queries.LockRotatedRefreshSession(ctx, db.LockRotatedRefreshSessionParams{ID: located.ID, PreviousRefreshTokenHash: previous})
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if session.WithinGrace {
		return ErrUnauthorized
	}

	if err := queries.RevokeSessionByID(ctx, session.ID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ErrRefreshReused
}

func (s *Service) Logout(ctx context.Context, raw string) error {
	verifier, err := tokenDigest(raw)
	if err != nil {
		return nil
	}

	return s.queries.RevokeSession(ctx, verifier)
}

func (s *Service) Authenticate(ctx context.Context, raw string) (User, error) {
	user, _, err := s.authenticateSession(ctx, raw)
	return user, err
}

func (s *Service) authenticateSession(ctx context.Context, raw string) (User, string, error) {
	userID, sessionID, err := s.parseAccess(raw)
	if err != nil {
		return User{}, "", ErrUnauthorized
	}

	user, err := s.queries.GetSessionPrincipal(ctx, db.GetSessionPrincipalParams{SessionID: sessionID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, "", ErrUnauthorized
	}

	if err != nil {
		return User{}, "", err
	}

	return User{
		ID:            idString(user.ID),
		FirstName:     user.FirstName,
		LastName:      user.LastName,
		Email:         user.Email,
		Role:          user.Role,
		CreatedAt:     user.CreatedAt.Time.UTC(),
		EmailVerified: user.EmailVerifiedAt.Valid,
	}, idString(sessionID), nil
}

func userView(user db.User) User {
	return User{
		ID:            idString(user.ID),
		FirstName:     user.FirstName,
		LastName:      user.LastName,
		Email:         user.Email,
		Role:          user.Role,
		CreatedAt:     user.CreatedAt.Time.UTC(),
		EmailVerified: user.EmailVerifiedAt.Valid,
	}
}
