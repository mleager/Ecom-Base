package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	passwordMemory     uint32 = 64 * 1024
	passwordIterations uint32 = 3
)

type passwordParameters struct {
	memory, iterations uint32
	parallelism        uint8
	salt, key          []byte
}

type passwords struct {
	slots chan struct{}
	dummy string
}

func newPasswords() (*passwords, error) {
	p := &passwords{slots: make(chan struct{}, 2)}
	var err error
	p.dummy, err = p.hash(context.Background(), "dummy verifier password; not an account")

	return p, err
}

func validPassword(password string) bool {
	n := utf8.RuneCountInString(password)
	return utf8.ValidString(password) && len(password) <= 512 && n >= 15 && n <= 128
}

func (p *passwords) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	select {
	case p.slots <- struct{}{}:
		return nil
	default:
		return ErrCapacity
	}
}

func (p *passwords) hash(ctx context.Context, password string) (string, error) {
	if err := p.acquire(ctx); err != nil {
		return "", err
	}

	defer func() { <-p.slots }()

	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}

	key := argon2.IDKey([]byte(password), salt, passwordIterations, passwordMemory, 1, 32)
	if err := ctx.Err(); err != nil {
		return "", err
	}

	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=1$%s$%s", passwordMemory, passwordIterations,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// verify spends one bounded Argon2 operation even for missing/malformed verifiers.
// No parameter from stored text can request an allocation above the current policy.
func (p *passwords) verify(ctx context.Context, password, encoded string) (bool, bool, error) {
	parameters, parseError := parsePassword(encoded)
	if parseError != nil {
		parameters, _ = parsePassword(p.dummy)
	}

	if err := p.acquire(ctx); err != nil {
		return false, false, err
	}

	defer func() { <-p.slots }()

	actual := argon2.IDKey([]byte(password), parameters.salt, parameters.iterations, parameters.memory, parameters.parallelism, 32)
	if err := ctx.Err(); err != nil {
		return false, false, err
	}

	matched := subtle.ConstantTimeCompare(actual, parameters.key) == 1 && parseError == nil

	needsUpgrade := parameters.memory < passwordMemory || parameters.iterations < passwordIterations

	return matched, needsUpgrade, nil
}

func parsePassword(encoded string) (passwordParameters, error) {
	invalid := errors.New("invalid password verifier")
	if len(encoded) > 256 {
		return passwordParameters{}, invalid
	}

	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return passwordParameters{}, invalid
	}

	values := strings.Split(parts[3], ",")
	if len(values) != 3 {
		return passwordParameters{}, invalid
	}

	var numeric [3]uint32
	for i, prefix := range []string{"m=", "t=", "p="} {
		if !strings.HasPrefix(values[i], prefix) {
			return passwordParameters{}, invalid
		}
		value, err := strconv.ParseUint(strings.TrimPrefix(values[i], prefix), 10, 32)
		if err != nil || values[i] != prefix+strconv.FormatUint(value, 10) {
			return passwordParameters{}, invalid
		}
		numeric[i] = uint32(value)
	}

	if numeric[0] < 19*1024 || numeric[0] > passwordMemory || numeric[1] < 2 || numeric[1] > passwordIterations || numeric[2] < 1 || numeric[2] > 4 {
		return passwordParameters{}, invalid
	}

	salt, saltError := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	key, keyError := base64.RawStdEncoding.Strict().DecodeString(parts[5])

	if saltError != nil || keyError != nil || len(salt) < 16 || len(salt) > 32 || len(key) != 32 {
		return passwordParameters{}, invalid
	}

	return passwordParameters{numeric[0], numeric[1], uint8(numeric[2]), salt, key}, nil
}
