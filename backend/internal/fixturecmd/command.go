// Package fixturecmd creates isolated local fixture databases. It never seeds
// an existing database, resets development data or runs during API startup.
package fixturecmd

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"
	"ecom/fixtures"

	"github.com/jackc/pgx/v5"
)

var namePattern = regexp.MustCompile(`^ecom_fixture_[a-f0-9]{16}$`)

type Metadata struct {
	Version int    `json:"version"`
	Name    string `json:"name"`
	Token   string `json:"token"`
	Server  string `json:"server"`
}

type Account struct {
	ID         string   `json:"id"`
	Email      string   `json:"email"`
	Password   string   `json:"password"`
	Role       string   `json:"role"`
	AddressIDs []string `json:"address_ids"`
}

// Bundle contains private local credentials and must never be printed/logged.
type Bundle struct {
	Metadata
	FixtureSHA256 string             `json:"fixture_sha256"`
	DatabaseURL   string             `json:"database_url"`
	JWTSecret     string             `json:"jwt_secret_base64"`
	HTTPAddress   string             `json:"http_addr"`
	Origin        string             `json:"frontend_origin"`
	Accounts      map[string]Account `json:"accounts"`
}

func randomHex(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", errors.New("random credential generation failed")
	}
	return hex.EncodeToString(data), nil
}

func directory(root, name string) (string, error) {
	if !namePattern.MatchString(name) {
		return "", errors.New("expected an isolated ecom_fixture identifier")
	}

	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		return "", errors.New("run from the repository root")
	}
	// No symlink/junction traversal into a different credential directory.

	current := root
	for _, part := range []string{".cache", "fixtures", name} {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.IsDir()) {
			return "", errors.New("fixture path must contain ordinary directories")
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", errors.New("fixture directory unavailable")
		}
	}

	return current, nil
}

func writeExclusive(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return errors.New("fixture output exists or could not be created")
	}

	_, writeErr := file.Write(data)
	closeErr := file.Close()

	if writeErr != nil || closeErr != nil {
		return errors.New("fixture output could not be written")
	}

	return nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return errors.New("fixture output encoding failed")
	}
	return writeExclusive(path, append(data, '\n'))
}

func readJSON(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return errors.New("fixture bundle unavailable or not a regular bounded file")
	}

	file, err := os.Open(path)
	if err != nil {
		return errors.New("fixture bundle unavailable")
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 64<<10))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(value); err != nil {
		return errors.New("fixture bundle invalid")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("fixture bundle has trailing content")
	}

	return nil
}

func apiEnvironment(b Bundle) string {
	return "APP_ENV=local\nHTTP_ADDR=" + b.HTTPAddress + "\nDATABASE_URL=" + b.DatabaseURL + "\nFRONTEND_ORIGIN=" + b.Origin + "\nJWT_SECRET_BASE64=" + b.JWTSecret + "\nMAIL_MODE=disabled\nSMTP_HOST=\nSMTP_PORT=\nSMTP_TLS_MODE=\nSMTP_USERNAME=\nSMTP_PASSWORD=\nMAIL_FROM=\n"
}

func credentials(getenv func(string) string) (*url.URL, error) {
	raw := getenv("ECOM_TEST_ADMIN_URL")
	if getenv("APP_ENV") != "local" || config.ValidateDatabase("local", raw) != nil {
		return nil, errors.New("fixtures require explicit local database configuration")
	}

	u, err := url.Parse(raw)
	if err != nil || (u.Hostname() != "localhost" && !net.ParseIP(u.Hostname()).IsLoopback()) || u.User.Username() != "postgres" || u.Fragment != "" {
		return nil, errors.New("fixtures require the local PostgreSQL administrator")
	}

	if len(u.Query()) != 1 || len(u.Query()["sslmode"]) != 1 || u.Query().Get("sslmode") != "disable" || getenv("ECOM_TEST_MIGRATOR_PASSWORD") == "" || getenv("ECOM_TEST_APP_PASSWORD") == "" {
		return nil, errors.New("fixtures require explicit loopback roles and sslmode=disable without overrides")
	}

	return u, nil
}

func connect(ctx context.Context, raw string) (*pgx.Conn, error) {
	c, err := pgx.ParseConfig(raw)
	if err != nil {
		return nil, errors.New("fixture connection configuration invalid")
	}

	c.ConnectTimeout = 5 * time.Second
	c.RuntimeParams["statement_timeout"] = "5000"
	c.RuntimeParams["lock_timeout"] = "2000"
	c.RuntimeParams["search_path"] = "public"

	conn, err := pgx.ConnectConfig(ctx, c)
	if err != nil {
		return nil, errors.New("fixture database connection failed")
	}

	return conn, nil
}

func roleURL(admin *url.URL, name, role, password string) string {
	u := *admin
	u.Path, u.RawPath = "/"+name, ""
	u.User = url.UserPassword(role, password)
	return u.String()
}

func marker(m Metadata) string {
	return fmt.Sprintf("ecom-fixtures:v%d:%s", m.Version, m.Token)
}

func owned(ctx context.Context, admin *pgx.Conn, m Metadata) (bool, error) {
	var owner, comment string
	err := admin.QueryRow(ctx, `SELECT pg_get_userbyid(datdba),COALESCE(shobj_description(oid,'pg_database'),'') FROM pg_database WHERE datname=$1`, m.Name).Scan(&owner, &comment)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil || owner != "ecom_migrator" || comment != marker(m) {
		return false, errors.New("fixture ownership marker mismatch; no database was removed")
	}
	return true, nil
}

func migrate(ctx context.Context, root, raw string) error {
	command := exec.CommandContext(ctx, "goose", "-env=none", "-dir", filepath.Join(root, "backend/migrations"), "up")
	for _, entry := range os.Environ() {
		upper := strings.ToUpper(entry)
		if !strings.HasPrefix(upper, "GOOSE_") && !strings.HasPrefix(upper, "PG") {
			command.Env = append(command.Env, entry)
		}
	}

	command.Env = append(command.Env, "GOOSE_DRIVER=postgres", "GOOSE_DBSTRING="+raw, "GOOSE_TABLE=public.goose_db_version")
	if command.Run() != nil {
		return errors.New("local goose fixture migration failed")
	}

	return nil
}

// prepareSchema applies the runtime grants and goose migrations to an empty
// database owned by ecom_migrator. It runs once per migration set, on the
// template database (see template.go).
func prepareSchema(ctx context.Context, root, migrationURL string) error {
	migrator, err := connect(ctx, migrationURL)
	if err != nil {
		return err
	}

	_, grantErr := migrator.Exec(ctx, `GRANT USAGE ON SCHEMA public TO ecom_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ecom_app`)
	// Close before goose and before the template is sealed: CREATE DATABASE
	// ... TEMPLATE refuses a source that still has connections.
	_ = migrator.Close(context.Background())
	if grantErr != nil {
		return errors.New("fixture runtime grants failed")
	}

	return migrate(ctx, root, migrationURL)
}

func create(ctx context.Context, root string, source *url.URL, getenv func(string) string) (Metadata, error) {
	suffix, err := randomHex(8)
	if err != nil {
		return Metadata{}, err
	}

	token, err := randomHex(32)
	if err != nil {
		return Metadata{}, err
	}

	m := Metadata{fixtures.Version, "ecom_fixture_" + suffix, token, source.Host}
	dir, err := directory(root, m.Name)
	if err != nil {
		return m, err
	}

	admin, err := connect(ctx, source.String())
	if err != nil {
		return Metadata{}, err
	}
	defer admin.Close(context.Background())

	// The migrated schema is built once per migration set and cloned below. A
	// failure here happens before any fixture-owned state exists.
	template, err := ensureTemplate(ctx, root, source, admin, getenv)
	if err != nil {
		return Metadata{}, err
	}

	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return m, errors.New("fixture parent directory unavailable")
	}

	if err := os.Mkdir(dir, 0o700); err != nil {
		return m, errors.New("fixture directory already exists or cannot be created")
	}

	if err := writeJSON(filepath.Join(dir, "metadata.json"), m); err != nil {
		return m, err
	}

	quoted := pgx.Identifier{m.Name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted+" TEMPLATE "+pgx.Identifier{template}.Sanitize()+" OWNER ecom_migrator"); err != nil {
		return m, errors.New("fixture database creation outcome requires inspection")
	}

	// Token is generated hex, not user-supplied SQL; database identifier is quoted.
	if _, err := admin.Exec(ctx, "COMMENT ON DATABASE "+quoted+" IS '"+marker(m)+"'"); err != nil {
		return m, errors.New("fixture ownership marker could not be recorded; inspect the new database")
	}

	migrationURL := roleURL(source, m.Name, "ecom_migrator", getenv("ECOM_TEST_MIGRATOR_PASSWORD"))
	migrator, err := connect(ctx, migrationURL)
	if err != nil {
		return m, err
	}
	defer migrator.Close(context.Background())

	secret, err := randomHex(32)
	if err != nil {
		return m, err
	}

	secretBytes, _ := hex.DecodeString(secret)
	b := Bundle{
		Metadata:    m,
		DatabaseURL: roleURL(source, m.Name, "ecom_app", getenv("ECOM_TEST_APP_PASSWORD")),
		JWTSecret:   base64.StdEncoding.EncodeToString(secretBytes),
		Accounts:    make(map[string]Account),
	}

	cfg, err := config.Load(func(key string) string {
		switch key {
		case "APP_ENV":
			return "local"
		case "DATABASE_URL":
			return b.DatabaseURL
		case "JWT_SECRET_BASE64":
			return b.JWTSecret
		case "HTTP_ADDR", "FRONTEND_ORIGIN":
			return getenv(key)
		default:
			return ""
		}
	})
	if err != nil {
		return m, err
	}

	b.HTTPAddress, b.Origin = cfg.HTTPAddress, cfg.FrontendOrigin
	origin, _ := url.Parse(b.Origin)

	if origin.Hostname() != "localhost" && !net.ParseIP(origin.Hostname()).IsLoopback() {
		return m, errors.New("fixture images require a loopback frontend origin")
	}

	if err := seed(ctx, migrator, &b, cfg.JWTSecret); err != nil {
		return m, errors.New("fixture seed failed; remove the isolated bundle before creating another")
	}

	if err := writeJSON(filepath.Join(dir, "bundle.json"), b); err != nil {
		return m, err
	}

	return m, writeExclusive(filepath.Join(dir, "api.env"), []byte(apiEnvironment(b)))
}

func inspectOrRemove(ctx context.Context, root, name string, remove bool, source *url.URL) (Metadata, error) {
	dir, err := directory(root, name)
	if err != nil {
		return Metadata{}, err
	}

	var m Metadata
	if err := readJSON(filepath.Join(dir, "metadata.json"), &m); err != nil {
		return m, err
	}

	if m.Name != name || m.Version < 1 || (!remove && m.Version != fixtures.Version) || m.Server != source.Host || len(m.Token) != 64 {
		return Metadata{}, errors.New("fixture metadata/host mismatch")
	}

	if _, err := hex.DecodeString(m.Token); err != nil {
		return Metadata{}, errors.New("fixture marker invalid")
	}

	admin, err := connect(ctx, source.String())
	if err != nil {
		return m, err
	}
	defer admin.Close(context.Background())

	exists, err := owned(ctx, admin, m)
	if err != nil {
		return m, err
	}

	if remove {
		if exists {
			if _, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{m.Name}.Sanitize()+" WITH (FORCE)"); err != nil {
				return m, errors.New("owned fixture database removal outcome requires inspection")
			}
		}
		// Exact files only: never recursively remove an operator-created directory.
		for _, file := range []string{"api.env", "bundle.json", "metadata.json"} {
			if err := os.Remove(filepath.Join(dir, file)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return m, errors.New("database removed; fixture files require local cleanup")
			}
		}
		if err := os.Remove(dir); err != nil {
			return m, errors.New("database removed; nonempty fixture directory retained")
		}
		return m, nil
	}
	if !exists {
		return m, errors.New("fixture database does not exist")
	}

	var b Bundle
	if err := readJSON(filepath.Join(dir, "bundle.json"), &b); err != nil {
		return m, err
	}

	_, digest, err := fixtures.Load()
	if err != nil || b.Metadata != m || b.FixtureSHA256 != digest || b.DatabaseURL == "" {
		return m, errors.New("fixture version/configuration mismatch")
	}

	u, err := url.Parse(b.DatabaseURL)
	if err != nil || config.ValidateDatabase("local", b.DatabaseURL) != nil || u.Host != source.Host || u.Path != "/"+name || u.User.Username() != "ecom_app" {
		return m, errors.New("fixture runtime target mismatch")
	}

	info, err := os.Lstat(filepath.Join(dir, "api.env"))
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return m, errors.New("fixture environment file invalid")
	}

	environment, err := os.ReadFile(filepath.Join(dir, "api.env"))
	if err != nil || string(environment) != apiEnvironment(b) {
		return m, errors.New("fixture environment does not match private bundle")
	}

	pool, err := database.Open(ctx, b.DatabaseURL)
	if err != nil {
		return m, err
	}
	defer pool.Close()

	return m, database.Ready(ctx, pool)
}

// Run emits only the fixture identifier/version/action, never connection URLs,
// credentials or low-level database errors. Incomplete creates retain metadata
// so the operator can inspect/remove that exact owned database.
func Run(ctx context.Context, root string, args []string, getenv func(string) string, output io.Writer) error {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		_, err := io.WriteString(output, "fixtures create | check <fixture-name> | remove <fixture-name>\n")
		return err
	}

	if len(args) == 0 || (args[0] != "create" && args[0] != "check" && args[0] != "remove") || (args[0] == "create" && len(args) != 1) || (args[0] != "create" && (len(args) != 2 || !namePattern.MatchString(args[1]))) {
		return errors.New("invalid fixture arguments; use fixtures --help")
	}

	source, err := credentials(getenv)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	var m Metadata
	if args[0] == "create" {
		m, err = create(ctx, root, source, getenv)
	} else {
		m, err = inspectOrRemove(ctx, root, args[1], args[0] == "remove", source)
	}
	if err != nil {
		if namePattern.MatchString(m.Name) {
			return fmt.Errorf("fixture %s: %w", m.Name, err)
		}
		return err
	}

	return json.NewEncoder(output).Encode(struct {
		Action  string `json:"action"`
		Fixture string `json:"fixture"`
		Version int    `json:"version"`
	}{args[0], m.Name, m.Version})
}
