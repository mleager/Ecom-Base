package auth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ecom/backend/internal/platform/clientip"
)

func TestAllowPeerClientIPSource(t *testing.T) {
	now := time.Now()
	request := func(viewer string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.RemoteAddr = "10.0.1.5:40000" // the load balancer
		if viewer != "" {
			r.Header.Set(clientip.ViewerAddressHeader, viewer)
		}
		return r
	}

	t.Run("peer ignores a forged viewer header", func(t *testing.T) {
		h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{})
		for i := 0; i < 21; i++ {
			if h.allowIP(httptest.NewRecorder(), request(fmt.Sprintf("198.51.100.%d:1000", i))) != (i < 20) {
				t.Fatal("forged CloudFront-Viewer-Address bypassed the peer limit")
			}
		}
	})

	t.Run("cloudfront limits each viewer", func(t *testing.T) {
		h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{ClientIP: clientip.CloudFront})
		for i := 0; i < 21; i++ {
			// The source port changes per connection; the limit keys on the IP.
			if h.allowIP(httptest.NewRecorder(), request(fmt.Sprintf("198.51.100.10:%d", 1000+i))) != (i < 20) {
				t.Fatal("viewer limit not applied by IP")
			}
		}
		if !h.allowIP(httptest.NewRecorder(), request("198.51.100.11:1000")) {
			t.Fatal("another viewer behind the same load balancer was limited")
		}
		w := httptest.NewRecorder()
		if h.allowIP(w, request("")) || w.Code != http.StatusBadRequest {
			t.Fatalf("request without the viewer header: status %d, want 400", w.Code)
		}
	})

	t.Run("an IPv6 client is its /64", func(t *testing.T) {
		h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{ClientIP: clientip.CloudFront})
		// Every request comes from a different address in one /64.
		for i := 0; i < 21; i++ {
			if h.allowIP(httptest.NewRecorder(), request(fmt.Sprintf("2001:db8:1:2::%x:443", i+1))) != (i < 20) {
				t.Fatal("rotating addresses inside one /64 escaped the client limit")
			}
		}
		if !h.allowIP(httptest.NewRecorder(), request("2001:db8:1:3::1:443")) {
			t.Fatal("a neighbouring /64 was limited")
		}
	})

	t.Run("an IPv6 site cannot multiply its budget over /64s", func(t *testing.T) {
		h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{ClientIP: clientip.CloudFront})
		admitted := 0
		// 10 /64s in one /48, 20 requests each: the /48 tier admits 80.
		for subnet := 0; subnet < 10; subnet++ {
			for i := 0; i < 20; i++ {
				if h.allowIP(httptest.NewRecorder(), request(fmt.Sprintf("2001:db8:1:%x::%x:443", subnet, i+1))) {
					admitted++
				}
			}
		}
		if admitted != 80 {
			t.Fatalf("one /48 admitted %d sign-in requests, want 80", admitted)
		}
		w := httptest.NewRecorder()
		if h.allowIP(w, request("2001:db8:1:ff::1:443")) || w.Code != http.StatusTooManyRequests {
			t.Fatalf("a fresh /64 in an exhausted /48: status %d, want 429", w.Code)
		}
		if !h.allowIP(httptest.NewRecorder(), request("2001:db8:2::1:443")) {
			t.Fatal("another /48 was limited")
		}
	})

	t.Run("IPv4 has no site tier", func(t *testing.T) {
		h := NewHandler(&Service{now: func() time.Time { return now }}, HTTPOptions{ClientIP: clientip.CloudFront})
		admitted := 0
		for host := 0; host < 10; host++ {
			for i := 0; i < 20; i++ {
				if h.allowIP(httptest.NewRecorder(), request(fmt.Sprintf("198.51.100.%d:%d", host, 1000+i))) {
					admitted++
				}
			}
		}
		if admitted != 200 {
			t.Fatalf("10 IPv4 clients admitted %d, want 200", admitted)
		}
	})
}
