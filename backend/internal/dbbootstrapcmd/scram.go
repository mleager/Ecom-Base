package dbbootstrapcmd

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

// scramIterations and scramSaltLength match PostgreSQL's defaults
// (scram_iterations = 4096, a 16-byte salt).
const (
	scramIterations = 4096
	scramSaltLength = 16
)

// newSCRAMVerifier returns the SCRAM-SHA-256 secret PostgreSQL stores for
// password, with a new random salt. Sending this instead of the password
// means no statement text, and so no server log line, ever contains it.
func newSCRAMVerifier(password string) (string, error) {
	salt := make([]byte, scramSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", errors.New("could not generate a password salt")
	}
	return scramVerifier(password, salt, scramIterations)
}

// scramVerifier follows RFC 5802 and RFC 7677 in PostgreSQL's format:
// SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, base64 each.
// PostgreSQL first applies SASLprep, which leaves printable ASCII
// unchanged; Load accepts only printable ASCII role passwords.
func scramVerifier(password string, salt []byte, iterations int) (string, error) {
	salted, err := pbkdf2.Key(sha256.New, password, salt, iterations, sha256.Size)
	if err != nil {
		return "", errors.New("could not derive the password verifier")
	}
	clientKey := hmacSHA256(salted, "Client Key")
	storedKey := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, "Server Key")
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s", iterations, b64(salt), b64(storedKey[:]), b64(serverKey)), nil
}

func hmacSHA256(key []byte, message string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	return mac.Sum(nil)
}

// printableASCII reports whether every byte is in 0x20–0x7E.
func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}
