package clientip

import (
	"net/netip"
	"testing"
)

func TestKey(t *testing.T) {
	cases := map[string]string{
		"192.0.2.7":                     "192.0.2.7",
		"2001:db8:1:2::1":               "2001:db8:1:2::/64",
		"2001:db8:1:2:ffff:ffff:ffff:1": "2001:db8:1:2::/64",
		"2001:db8:1:3::1":               "2001:db8:1:3::/64",
		"::1":                           "::/64",
	}
	for address, want := range cases {
		if got := Key(netip.MustParseAddr(address)); got != want {
			t.Fatalf("Key(%s) = %s, want %s", address, got, want)
		}
	}
}

func TestSiteKey(t *testing.T) {
	if key, ok := SiteKey(netip.MustParseAddr("192.0.2.7")); ok || key != "" {
		t.Fatalf("IPv4 SiteKey = %q, %v; want no tier", key, ok)
	}
	for _, address := range []string{"2001:db8:1:2::1", "2001:db8:1:ffff::9"} {
		key, ok := SiteKey(netip.MustParseAddr(address))
		if !ok || key != "2001:db8:1::/48" {
			t.Fatalf("SiteKey(%s) = %q, %v; want 2001:db8:1::/48", address, key, ok)
		}
	}
	if key, _ := SiteKey(netip.MustParseAddr("2001:db8:2::1")); key != "2001:db8:2::/48" {
		t.Fatalf("another site shares a key: %s", key)
	}
}
