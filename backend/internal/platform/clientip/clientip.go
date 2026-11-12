// Package clientip decides which address a request came from. Rate limits key
// on it, so it trusts a proxy header only when the deployment says a proxy
// sets it (TRUSTED_PROXY); otherwise it uses the TCP peer.
package clientip

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

// ViewerAddressHeader is set by CloudFront when the origin request policy
// includes it: the viewer's IP and source port, such as 198.51.100.10:46532
// or 2001:db8::1:46532 (IPv6 without brackets).
const ViewerAddressHeader = "CloudFront-Viewer-Address"

// Source is the TRUSTED_PROXY setting. The zero value uses the TCP peer.
type Source string

const (
	Peer       Source = ""
	CloudFront Source = "cloudfront"
)

// ParseSource validates a TRUSTED_PROXY value.
func ParseSource(value string) (Source, error) {
	switch Source(value) {
	case Peer, CloudFront:
		return Source(value), nil
	}
	return Peer, errors.New("TRUSTED_PROXY must be empty or cloudfront")
}

// From returns the request's client IP. It fails when the address is missing
// or malformed; with CloudFront that includes a missing or repeated header,
// so a request that bypassed CloudFront is refused rather than keyed on the
// load balancer's address.
func (s Source) From(r *http.Request) (netip.Addr, bool) {
	if s == CloudFront {
		values := r.Header.Values(ViewerAddressHeader)
		if len(values) != 1 {
			return netip.Addr{}, false
		}
		return parseViewerAddress(values[0])
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	address, err := netip.ParseAddr(host)
	if err != nil || address.Zone() != "" {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}

func parseViewerAddress(value string) (netip.Addr, bool) {
	cut := strings.LastIndexByte(value, ':')
	if cut <= 0 {
		return netip.Addr{}, false
	}
	host, port := value[:cut], value[cut+1:]
	if number, err := strconv.Atoi(port); err != nil || number < 0 || number > 65535 || port != strconv.Itoa(number) {
		return netip.Addr{}, false
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	address, err := netip.ParseAddr(host)
	if err != nil || address.Zone() != "" {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}
