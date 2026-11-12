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
}
