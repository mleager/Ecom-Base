package checkout

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRecoveryCookieAttributes(t *testing.T) {
	deadline := time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, secure := range []bool{false, true} {
		h := NewGuestHandler(nil, nil, secure)
		w := httptest.NewRecorder()
		h.setRecoveryCookie(w, "token", deadline, 0)
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatalf("got %d cookies", len(cookies))
		}
		c := cookies[0]
		if c.Name != guestRecoveryCookie || c.Value != "token" || !c.HttpOnly || c.Secure != secure || c.Domain != "" || c.Path != "/api/v1/guest" || c.SameSite != http.SameSiteStrictMode || !c.Expires.Equal(deadline) {
			t.Fatalf("unexpected recovery cookie (secure=%v): %+v", secure, c)
		}
	}
}
