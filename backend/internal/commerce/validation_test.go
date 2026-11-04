package commerce

import (
	"errors"
	"strings"
	"testing"
)

func ptr[T any](value T) *T { return &value }

func TestAddressValidation(t *testing.T) {
	valid := func() AddressInput {
		return AddressInput{RecipientName: ptr(" Test Customer "), Line1: ptr(" 1 Main St "), City: ptr(" Portland "), Region: ptr(" or "), PostalCode: ptr("97201-1234")}
	}
	input := valid()
	if !input.valid(true) || *input.Region != "OR" || *input.Line1 != "1 Main St" {
		t.Fatal("address normalization failed")
	}
	for _, tc := range []struct {
		name   string
		change func(*AddressInput)
	}{
		{"missing recipient", func(a *AddressInput) { a.RecipientName = nil }},
		{"blank line", func(a *AddressInput) { a.Line1 = ptr("  ") }},
		{"long name", func(a *AddressInput) { a.RecipientName = ptr(strings.Repeat("é", 201)) }},
		{"null byte", func(a *AddressInput) { a.City = ptr("a\x00b") }},
		{"unknown state", func(a *AddressInput) { a.Region = ptr("ZZ") }},
		{"territory outside scope", func(a *AddressInput) { a.Region = ptr("PR") }},
		{"short zip", func(a *AddressInput) { a.PostalCode = ptr("1234") }},
		{"unicode digits", func(a *AddressInput) { a.PostalCode = ptr("１２３４５") }},
		{"non-US", func(a *AddressInput) { a.CountryCode = ptr("CA") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := valid()
			tc.change(&a)
			if a.valid(true) {
				t.Fatal("accepted invalid address")
			}
		})
	}
	if (&AddressInput{}).valid(false) {
		t.Fatal("empty patch accepted")
	}
	if !(&AddressInput{Label: ptr(""), Line2: ptr("")}).valid(false) {
		t.Fatal("optional text clearing rejected")
	}
	if (&AddressInput{City: ptr("Boston"), CountryCode: ptr("US")}).valid(false) {
		t.Fatal("country patch accepted")
	}
	if !(&AddressInput{Region: ptr("dc")}).valid(false) {
		t.Fatal("DC rejected")
	}
}

func TestProductValidation(t *testing.T) {
	valid := func() ProductInput {
		return ProductInput{SKU: ptr(" SKU-._1 "), Name: ptr(" Product "), UnitPriceCents: ptr(MaxPrice), ImageURL: ptr("https://example.com/image.png")}
	}
	input := valid()
	if !input.valid(true) || *input.SKU != "SKU-._1" || *input.Name != "Product" {
		t.Fatal("valid product rejected")
	}
	for _, tc := range []struct {
		name   string
		change func(*ProductInput)
	}{
		{"missing price", func(p *ProductInput) { p.UnitPriceCents = nil }},
		{"negative price", func(p *ProductInput) { p.UnitPriceCents = ptr(int64(-1)) }},
		{"price overflow", func(p *ProductInput) { p.UnitPriceCents = ptr(MaxPrice + 1) }},
		{"SKU whitespace", func(p *ProductInput) { p.SKU = ptr("A B") }},
		{"SKU Unicode", func(p *ProductInput) { p.SKU = ptr("é") }},
		{"long SKU", func(p *ProductInput) { p.SKU = ptr(strings.Repeat("A", 65)) }},
		{"script URL", func(p *ProductInput) { p.ImageURL = ptr("javascript:alert(1)") }},
		{"relative URL", func(p *ProductInput) { p.ImageURL = ptr("/image.png") }},
		{"URL without host", func(p *ProductInput) { p.ImageURL = ptr("https:///image.png") }},
		{"URL credentials", func(p *ProductInput) { p.ImageURL = ptr("https://user:password@example.com/image.png") }},
		{"URL whitespace", func(p *ProductInput) { p.ImageURL = ptr("https://example.com/a b") }},
		{"long description", func(p *ProductInput) { p.Description = ptr(strings.Repeat("é", 4001)) }},
		{"activation on create", func(p *ProductInput) { p.IsActive = ptr(true) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := valid()
			tc.change(&p)
			if p.valid(true) {
				t.Fatal("accepted invalid product")
			}
		})
	}
	if (&ProductInput{}).valid(false) {
		t.Fatal("empty patch accepted")
	}
	if !(&ProductInput{UnitPriceCents: ptr(int64(0)), Description: ptr(""), ImageURL: ptr(""), IsActive: ptr(false)}).valid(false) {
		t.Fatal("explicit zero/false/clearing rejected")
	}
}

func TestPaginationAndIDs(t *testing.T) {
	for _, tc := range []struct {
		query         string
		limit, offset int64
		err           error
	}{
		{"", 20, 0, nil}, {"limit=100&offset=2147483648", 100, 2147483648, nil},
		{"limit=0", 0, 0, ErrInvalidInput}, {"limit=101", 0, 0, ErrInvalidInput}, {"offset=-1", 0, 0, ErrInvalidInput},
		{"limit=1.5", 0, 0, errQuery}, {"limit=", 0, 0, errQuery}, {"limit=1&limit=2", 0, 0, errQuery},
		{"offset=9223372036854775808", 0, 0, ErrInvalidInput}, {"limit=%zz", 0, 0, errQuery}, {"unknown=1", 0, 0, errQuery},
	} {
		limit, offset, err := pagination(tc.query)
		if !errors.Is(err, tc.err) || limit != tc.limit || offset != tc.offset {
			t.Errorf("pagination %q = %d,%d,%v", tc.query, limit, offset, err)
		}
	}
	for _, raw := range []string{"", "invalid", "11111111111141118111111111111111", "11111111_1111-4111-8111-111111111111"} {
		if _, err := parseID(raw); !errors.Is(err, ErrMalformedID) {
			t.Errorf("accepted malformed ID %q", raw)
		}
	}
	id, err := newID()
	if err != nil || id.Bytes[6]>>4 != 4 || id.Bytes[8]>>6 != 2 {
		t.Fatal("invalid UUIDv4")
	}
	parsed, err := parseID(idString(id))
	if err != nil || parsed != id {
		t.Fatal("UUID roundtrip failed")
	}
}
