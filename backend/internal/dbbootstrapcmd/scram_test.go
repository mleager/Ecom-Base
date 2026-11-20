package dbbootstrapcmd

import (
	"regexp"
	"strings"
	"testing"
)

// The expected value was computed independently with Python's hashlib and
// hmac (RFC 5802 with SHA-256, PostgreSQL's format).
func TestSCRAMVerifierKnownValue(t *testing.T) {
	salt := make([]byte, 16)
	for i := range salt {
		salt[i] = byte(i)
	}
	got, err := scramVerifier("correct horse battery staple", salt, 4096)
	if err != nil {
		t.Fatal(err)
	}
	const want = "SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$ONYbSJBXtKl6bP6PVqw8pm9e7EiacprLnoUQPFS80Hw=:IPOtHuGJ2HifEQg74W2XXqqCrCyQG55GbPRHa6g6n9w="
	if got != want {
		t.Fatalf("verifier\n got %s\nwant %s", got, want)
	}
}

var verifierFormat = regexp.MustCompile(`^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$`)

// The statement sent to PostgreSQL carries only a verifier: never the
// password, and a new salt on every run.
func TestPasswordStatementOmitsPassword(t *testing.T) {
	first, err := passwordStatement(AppRole, appSecret)
	if err != nil {
		t.Fatal(err)
	}
	second, err := passwordStatement(AppRole, appSecret)
	if err != nil {
		t.Fatal(err)
	}
	const prefix = `ALTER ROLE "ecom_app" LOGIN PASSWORD '`
	for _, statement := range []string{first, second} {
		if strings.Contains(statement, appSecret) {
			t.Fatal("statement contains the password")
		}
		verifier, ok := strings.CutPrefix(statement, prefix)
		verifier, closed := strings.CutSuffix(verifier, "'")
		if !ok || !closed || !verifierFormat.MatchString(verifier) {
			t.Fatalf("statement shape: %s", statement)
		}
	}
	if first == second {
		t.Fatal("two runs used the same salt")
	}
}

func TestRoleTimeoutStatements(t *testing.T) {
	got := strings.Join(roleTimeoutStatements(), "\n")
	want := strings.Join([]string{
		`ALTER ROLE "ecom_app" SET statement_timeout = 5000`,
		`ALTER ROLE "ecom_app" SET lock_timeout = 2000`,
		`ALTER ROLE "ecom_app" SET idle_in_transaction_session_timeout = 30000`,
	}, "\n")
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}
