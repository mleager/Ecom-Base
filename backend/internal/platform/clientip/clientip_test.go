package clientip

import (
	"net/http/httptest"
	"testing"
)

func TestParseSource(t *testing.T) {
	for _, value := range []string{"", "cloudfront"} {
		if _, err := ParseSource(value); err != nil {
			t.Fatalf("ParseSource(%q): %v", value, err)
		}
	}
	for _, value := range []string{"CloudFront", "x-forwarded-for", "true", " cloudfront"} {
		if _, err := ParseSource(value); err == nil {
			t.Fatalf("ParseSource(%q) accepted", value)
		}
	}
}

func TestPeerIgnoresProxyHeaders(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "192.0.2.7:5000"
	r.Header.Set(ViewerAddressHeader, "198.51.100.10:46532")
	r.Header.Set("X-Forwarded-For", "198.51.100.11")
	address, ok := Peer.From(r)
	if !ok || address.String() != "192.0.2.7" {
		t.Fatalf("Peer.From = %v, %v; want the TCP peer", address, ok)
	}

	r.RemoteAddr = "[::ffff:192.0.2.8]:5000"
	if address, ok := Peer.From(r); !ok || address.String() != "192.0.2.8" {
		t.Fatalf("mapped peer = %v, %v", address, ok)
	}

	for _, remote := range []string{"", "192.0.2.7", "example.com:80", "[fe80::1%eth0]:80"} {
		r.RemoteAddr = remote
		if _, ok := Peer.From(r); ok {
			t.Fatalf("Peer.From accepted RemoteAddr %q", remote)
		}
	}
}

func TestCloudFrontUsesViewerAddress(t *testing.T) {
	cases := map[string]string{
		"198.51.100.10:46532":       "198.51.100.10",
		"2001:db8::1:46532":         "2001:db8::1",
		"[2001:db8::2]:443":         "2001:db8::2",
		"::ffff:198.51.100.12:1000": "198.51.100.12",
	}
	for header, want := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "10.0.1.5:40000"
		r.Header.Set(ViewerAddressHeader, header)
		address, ok := CloudFront.From(r)
		if !ok || address.String() != want {
			t.Fatalf("CloudFront.From(%q) = %v, %v; want %s", header, address, ok, want)
		}
	}
}

func TestCloudFrontRefusesMissingOrMalformedHeader(t *testing.T) {
	bad := []string{"", "198.51.100.10", "198.51.100.10:", "198.51.100.10:x", "198.51.100.10:70000", "198.51.100.10:+1",
		"example.com:443", ":443", "fe80::1%eth0:443", "198.51.100.10:443, 198.51.100.11:443"}
	for _, header := range bad {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "10.0.1.5:40000"
		r.Header.Set(ViewerAddressHeader, header)
		if address, ok := CloudFront.From(r); ok {
			t.Fatalf("CloudFront.From(%q) accepted %v", header, address)
		}
	}

	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.1.5:40000"
	if _, ok := CloudFront.From(r); ok {
		t.Fatal("CloudFront.From accepted a request without the header (fell back to the peer)")
	}
	r.Header.Add(ViewerAddressHeader, "198.51.100.10:1")
	r.Header.Add(ViewerAddressHeader, "198.51.100.11:1")
	if _, ok := CloudFront.From(r); ok {
		t.Fatal("CloudFront.From accepted a repeated header")
	}
}
