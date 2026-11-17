// Package backend embeds the SQL migrations for cmd/migrate and the
// maintenance SQL for cmd/maintain. This file sits
// outside backend/migrations because the goose CLI's validate treats every
// .go file in that directory as a migration.
package backend

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var embedded embed.FS

// GuestMaintenance is one batch of guest cleanup (maintenance/guest_sessions.sql).
//
//go:embed maintenance/guest_sessions.sql
var GuestMaintenance string

// Migrations returns the NNNNN_name.sql files at the root of the FS.
func Migrations() fs.FS {
	migrations, err := fs.Sub(embedded, "migrations")
	if err != nil {
		panic("embedded migrations directory missing")
	}
	return migrations
}
