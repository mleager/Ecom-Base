// Package backend embeds the SQL migrations for cmd/migrate. This file sits
// outside backend/migrations because the goose CLI's validate treats every
// .go file in that directory as a migration.
package backend

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var embedded embed.FS

// Migrations returns the NNNNN_name.sql files at the root of the FS.
func Migrations() fs.FS {
	migrations, err := fs.Sub(embedded, "migrations")
	if err != nil {
		panic("embedded migrations directory missing")
	}
	return migrations
}
