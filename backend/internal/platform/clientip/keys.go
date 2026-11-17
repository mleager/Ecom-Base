package clientip

import "net/netip"

// Rate-limit keys. A per-address limit is no limit for IPv6: the smallest
// network a host is given is a /64 (2^64 addresses it can rotate through),
// and a home or office usually gets a /56 or /48. So one client is keyed on
// its /64, and the most sensitive limiters add a looser tier on the /48 so
// one site cannot multiply its budget over its /64s. IPv4 addresses are
// scarce and keyed whole; addresses shared behind carrier NAT remain a known
// source of false positives.
const (
	ClientPrefixBits = 64
	SitePrefixBits   = 48
)

// Key is the rate-limit key for one client: an IPv4 address such as
// "192.0.2.7", or the /64 that holds an IPv6 address, such as
// "2001:db8:1:2::/64". Callers pass addresses from Source.From, which are
// unmapped and have no zone.
func Key(address netip.Addr) string {
	if address.Is4() {
		return address.String()
	}
	return netip.PrefixFrom(address, ClientPrefixBits).Masked().String()
}

// SiteKey is the key for the wider IPv6 tier, the /48 that holds the
// address. IPv4 has no wider tier, so ok is false.
func SiteKey(address netip.Addr) (key string, ok bool) {
	if !address.Is6() {
		return "", false
	}
	return netip.PrefixFrom(address, SitePrefixBits).Masked().String(), true
}
