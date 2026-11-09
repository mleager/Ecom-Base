package fixturecmd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

// A fixture template is an empty, fully migrated database that every fixture
// is cloned from with CREATE DATABASE ... TEMPLATE, so goose runs once per
// migration set instead of once per fixture. Its name carries a digest of the
// migration files (and templateFormat), so any migration change selects a new
// template. Templates hold schema only: products, accounts, secrets and the
// ownership marker are still created per fixture.
//
// The name deliberately does not match namePattern, so `check` and `remove`
// can never target a template.
const (
	templateFormat  = 1 // bump when prepareSchema changes what a template holds
	templatePrefix  = "ecom_fixture_template_"
	templateLockKey = int64(0x65636f6d74706c31) // "ecomtpl1": serialises template builds
)

var templatePattern = regexp.MustCompile(`^ecom_fixture_template_[a-f0-9]{16}$`)

func templateMarker(digest string) string {
	return fmt.Sprintf("ecom-fixtures-template:v%d:%s", templateFormat, digest)
}

// migrationDigest hashes every file goose would read from backend/migrations,
// in name order, together with the template format.
func migrationDigest(root string) (string, error) {
	dir := filepath.Join(root, "backend", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", errors.New("fixture migrations unavailable")
	}

	h := sha256.New()
	fmt.Fprintf(h, "ecom-fixtures-template:v%d\n", templateFormat)
	count := 0
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			return "", errors.New("fixture migrations must be ordinary files")
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return "", errors.New("fixture migration unreadable")
		}
		fmt.Fprintf(h, "%s\x00%d\x00", entry.Name(), len(data))
		h.Write(data)
		count++
	}
	if count == 0 {
		return "", errors.New("fixture migrations unavailable")
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

type templateState int

const (
	templateAbsent templateState = iota
	templateReady
	templateIncomplete // ours, but a build was interrupted before it was sealed
)

func inspectTemplate(ctx context.Context, admin *pgx.Conn, name, digest string) (templateState, error) {
	var owner, comment string
	var allowConnections, isTemplate bool
	err := admin.QueryRow(ctx, `SELECT pg_get_userbyid(datdba),COALESCE(shobj_description(oid,'pg_database'),''),datallowconn,datistemplate FROM pg_database WHERE datname=$1`, name).Scan(&owner, &comment, &allowConnections, &isTemplate)
	if errors.Is(err, pgx.ErrNoRows) {
		return templateAbsent, nil
	}
	if err != nil {
		return templateAbsent, errors.New("fixture template inspection failed")
	}

	ready := templateMarker(digest)
	switch {
	case owner != "ecom_migrator" || (comment != ready && comment != ready+":building"):
		return templateAbsent, errors.New("fixture template name is held by an unowned database; no database was changed")
	case comment == ready && !allowConnections && isTemplate:
		return templateReady, nil
	default:
		return templateIncomplete, nil
	}
}

func dropTemplate(ctx context.Context, admin *pgx.Conn, name string) error {
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "ALTER DATABASE "+quoted+" WITH IS_TEMPLATE false"); err != nil {
		return err
	}
	_, err := admin.Exec(ctx, "DROP DATABASE "+quoted+" WITH (FORCE)")
	return err
}

func lockTemplates(ctx context.Context, admin *pgx.Conn) (func(), error) {
	for {
		var locked bool
		if err := admin.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, templateLockKey).Scan(&locked); err != nil {
			return nil, errors.New("fixture template lock unavailable")
		}
		if locked {
			return func() {
				unlock, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_, _ = admin.Exec(unlock, `SELECT pg_advisory_unlock($1)`, templateLockKey)
			}, nil
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("timed out waiting for another fixture template build")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// ensureTemplate returns the name of a sealed template for the current
// migrations, building it first if needed. Concurrent creates wait on an
// advisory lock while one of them builds; the rest reuse its result.
func ensureTemplate(ctx context.Context, root string, source *url.URL, admin *pgx.Conn, getenv func(string) string) (string, error) {
	digest, err := migrationDigest(root)
	if err != nil {
		return "", err
	}
	name := templatePrefix + digest[:16]

	if state, err := inspectTemplate(ctx, admin, name, digest); err != nil || state == templateReady {
		return name, err
	}

	unlock, err := lockTemplates(ctx, admin)
	if err != nil {
		return "", err
	}
	defer unlock()

	state, err := inspectTemplate(ctx, admin, name, digest)
	if err != nil {
		return "", err
	}
	switch state {
	case templateReady:
		return name, nil
	case templateIncomplete:
		if dropTemplate(ctx, admin, name) != nil {
			return "", errors.New("interrupted fixture template could not be removed")
		}
	}

	quoted := pgx.Identifier{name}.Sanitize()
	ready := templateMarker(digest)
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted+" OWNER ecom_migrator"); err != nil {
		return "", errors.New("fixture template creation failed")
	}
	// Digest is generated hex, not user-supplied SQL. Until it is sealed the
	// template is marked as building and is rebuilt by the next create.
	if _, err := admin.Exec(ctx, "COMMENT ON DATABASE "+quoted+" IS '"+ready+":building'"); err != nil {
		return "", errors.New("fixture template marker could not be recorded")
	}
	if err := prepareSchema(ctx, root, roleURL(source, name, "ecom_migrator", getenv("ECOM_TEST_MIGRATOR_PASSWORD"))); err != nil {
		return "", err
	}
	// Refusing connections keeps the template unchanged and clonable: CREATE
	// DATABASE ... TEMPLATE fails while anything is connected to the source.
	if _, err := admin.Exec(ctx, "ALTER DATABASE "+quoted+" WITH ALLOW_CONNECTIONS false IS_TEMPLATE true"); err != nil {
		return "", errors.New("fixture template could not be sealed")
	}
	if _, err := admin.Exec(ctx, "COMMENT ON DATABASE "+quoted+" IS '"+ready+"'"); err != nil {
		return "", errors.New("fixture template marker could not be recorded")
	}

	dropStaleTemplates(ctx, admin, name)
	return name, nil
}

// dropStaleTemplates removes owned templates built for other migration sets.
// It is best effort: a template that is being cloned holds a lock that makes
// the DROP time out, and it is simply retried after the next rebuild.
func dropStaleTemplates(ctx context.Context, admin *pgx.Conn, current string) {
	rows, err := admin.Query(ctx, `SELECT datname FROM pg_database WHERE datname LIKE 'ecom\_fixture\_template\_%' AND datname<>$1 AND pg_get_userbyid(datdba)='ecom_migrator' AND COALESCE(shobj_description(oid,'pg_database'),'') LIKE $2`, current, fmt.Sprintf("ecom-fixtures-template:v%d:%%", templateFormat))
	if err != nil {
		return
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return
	}
	for _, name := range names {
		if templatePattern.MatchString(name) {
			_ = dropTemplate(ctx, admin, name)
		}
	}
}
