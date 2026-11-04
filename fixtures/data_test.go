package fixtures

import (
	"encoding/xml"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCatalogAndImages(t *testing.T) {
	catalog, digest, err := Load()
	if err != nil || catalog.Version != Version || len(catalog.Products) != 36 || len(digest) != 64 {
		t.Fatal("versioned fixture catalog invalid")
	}
	_, again, err := Load()
	if err != nil || again != digest {
		t.Fatal("fixture content digest is not stable")
	}
	ids, keys, skus := map[string]bool{}, map[string]bool{}, map[string]bool{}
	active, broken := 0, 0
	server := httptest.NewServer(http.FileServer(http.FS(Public())))
	defer server.Close()
	for _, p := range catalog.Products {
		if ids[p.ID] || keys[p.Key] || skus[p.SKU] || len(p.ID) != 36 || p.Key == "" || p.SKU == "" || p.Name == "" || p.Price < 0 || p.Price > 1_000_000_000_000 || p.Stock < 0 {
			t.Fatal("duplicate or invalid fixture product")
		}
		ids[p.ID], keys[p.Key], skus[p.SKU] = true, true, true
		if p.Active {
			active++
		}
		if p.Image == "" {
			continue
		}
		response, err := server.Client().Get(server.URL + "/fixtures/v1/" + p.Image)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if p.Key == "broken_image" {
			if response.StatusCode != 404 {
				t.Fatal("controlled missing image did not return 404")
			}
			broken++
		} else if response.StatusCode != 200 || response.Header.Get("Content-Type") != "image/svg+xml" {
			t.Fatal("local catalog image is not served as SVG")
		}
	}
	if active != 34 || broken != 1 {
		t.Fatal("fixture activity/image cases changed without updating their contract")
	}
	err = fs.WalkDir(Public(), ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := fs.ReadFile(Public(), path)
		if err != nil {
			return err
		}
		decoder := xml.NewDecoder(strings.NewReader(string(data)))
		root := false
		for {
			token, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if start, ok := token.(xml.StartElement); ok {
				if !root {
					if start.Name.Local != "svg" {
						t.Fatal("illustration has no SVG root")
					}
					root = true
				}
				if start.Name.Local == "script" || start.Name.Local == "image" || start.Name.Local == "foreignObject" {
					t.Fatal("fixture SVG contains executable or external content")
				}
				for _, a := range start.Attr {
					if strings.HasPrefix(a.Name.Local, "on") || a.Name.Local == "href" {
						t.Fatal("fixture SVG has active content")
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
