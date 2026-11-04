// Package fixtures contains the versioned, nonsecret Project 1 demonstration
// catalog and first-party public illustrations. The API does not seed on startup.
package fixtures

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
)

const Version = 1

//go:embed catalog.v1.json public
var files embed.FS

type Product struct {
	Key         string `json:"key"`
	ID          string `json:"id"`
	SKU         string `json:"sku"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Image       string `json:"image"`
	Price       int64  `json:"unit_price_cents"`
	Stock       int32  `json:"quantity_on_hand"`
	Active      bool   `json:"is_active"`
}

type Catalog struct {
	Version  int       `json:"version"`
	Products []Product `json:"products"`
}

func Load() (Catalog, string, error) {
	data, err := files.ReadFile("catalog.v1.json")
	if err != nil {
		return Catalog{}, "", err
	}
	var catalog Catalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return Catalog{}, "", err
	}
	digest := sha256.New()
	_, _ = digest.Write(data)
	err = fs.WalkDir(files, "public", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, err := files.ReadFile(path)
		if err != nil {
			return err
		}
		_, _ = digest.Write([]byte(path + "\x00"))
		_, _ = digest.Write(data)
		return nil
	})
	return catalog, hex.EncodeToString(digest.Sum(nil)), err
}

func Public() fs.FS {
	public, err := fs.Sub(files, "public")
	if err != nil {
		panic("embedded fixture public directory missing")
	}
	return public
}
