package commerce

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"

	"ecom/backend/internal/platform/httpjson"
)

func TestCatalogQuery(t *testing.T) {
	for _, tc := range []struct {
		raw   string
		admin bool
		err   error
	}{
		{"", false, nil}, {"q=&limit=100&offset=9223372036854775807", false, nil},
		{"q=" + url.QueryEscape(strings.Repeat("é", 200)), false, nil},
		{"q=" + url.QueryEscape(strings.Repeat("é", 201)), false, ErrInvalidInput},
		{"q=%ff", false, ErrInvalidInput}, {"q=%00", false, ErrInvalidInput},
		{"q=%zz", false, errQuery}, {"q=a&q=b", false, errQuery}, {"q=a&limit=1&limit=2", false, errQuery},
		{"is_active=true", false, errQuery}, {"unknown=1", false, errQuery},
		{"limit=0", false, ErrInvalidInput}, {"limit=101", true, ErrInvalidInput},
		{"offset=-1", true, ErrInvalidInput}, {"offset=9223372036854775808", false, ErrInvalidInput},
		{"offset=1.5", true, errQuery}, {"limit=", false, errQuery},
		{"is_active=true", true, nil}, {"is_active=false", true, nil}, {"", true, nil},
		{"is_active=", true, errQuery}, {"is_active=TRUE", true, errQuery}, {"is_active=1", true, errQuery},
		{"is_active=false&is_active=true", true, errQuery}, {"q=product&is_active=false&limit=50&offset=100", true, nil},
		{"q=" + url.QueryEscape(strings.Repeat("é", 200)), true, nil},
		{"q=" + url.QueryEscape(strings.Repeat("é", 201)), true, ErrInvalidInput},
		{"q=%ff", true, ErrInvalidInput}, {"q=%00", true, ErrInvalidInput}, {"q=%zz", true, errQuery}, {"q=a&q=b", true, errQuery},
	} {
		t.Run(fmt.Sprintf("%s admin=%t", tc.raw, tc.admin), func(t *testing.T) {
			_, err := parseProductQuery(tc.raw, tc.admin)
			if !errors.Is(err, tc.err) {
				t.Fatalf("error = %v, want %v", err, tc.err)
			}
		})
	}
	query, err := parseProductQuery("is_active=false&limit=3&offset=5", true)
	if err != nil || query.isActive == nil || *query.isActive || query.limit != 3 || query.offset != 5 {
		t.Fatal("admin filter/pagination lost false or explicit bounds")
	}
	query, err = parseProductQuery("", true)
	if err != nil || query.isActive != nil || query.limit != 20 || query.offset != 0 {
		t.Fatal("default list should include both activity states")
	}
	for _, raw := range []string{"q=product", "is_active=true"} {
		if _, _, err := httpjson.Pagination(raw); !errors.Is(err, httpjson.ErrPagination) {
			t.Fatal("catalog filters broadened order pagination")
		}
	}
}

func TestProductSearchPattern(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"", ""}, {" \t\u2003", ""}, {" Café ", "%Café%"},
		{`a!%_\b`, `%a!!!%!_\b%`}, {`' OR true --`, `%' OR true --%`},
	} {
		pattern, err := productSearchPattern(tc.input)
		if err != nil || pattern != tc.want {
			t.Fatalf("pattern %q = %q, %v; want %q", tc.input, pattern, err, tc.want)
		}
	}
}
