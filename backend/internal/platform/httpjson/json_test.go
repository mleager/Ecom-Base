package httpjson

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStrictOptionalJSON(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{}`, 200}, {`{"name":""}`, 200}, {`{"name":"Test","count":0}`, 200},
		{`{"Name":"alias"}`, 400}, {`{"name":"a","name":"b"}`, 400}, {`{"name":null}`, 400},
		{`{"count":1.5}`, 400}, {`{"count":"1"}`, 400}, {`{"extra":1}`, 400}, {`[]`, 400},
		{`{} {}`, 400}, {`{"name":"` + strings.Repeat("a", 65<<10) + `"}`, 413},
	} {
		t.Run(tc.body[:min(len(tc.body), 30)], func(t *testing.T) {
			var input struct {
				Name  *string `json:"name"`
				Count *int64  `json:"count"`
			}
			r := httptest.NewRequest("PATCH", "/", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			ok := Decode(w, r, &input, []string{"name", "count"}, nil)
			if ok != (tc.status == 200) || w.Code != tc.status {
				t.Fatalf("ok=%v status=%d", ok, w.Code)
			}
		})
	}
	var input struct {
		Name string `json:"name"`
	}
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	if Decode(w, r, &input, []string{"name"}, []string{"name"}) || w.Code != 400 {
		t.Fatal("missing required field accepted")
	}
}
