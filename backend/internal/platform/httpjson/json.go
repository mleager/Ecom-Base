package httpjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"unicode/utf8"
)

// Bodyless accepts only an empty body or whitespace within the API body limit.
func Bodyless(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			Error(w, 413, "body_too_large", "Body exceeds 64 KiB")
		} else {
			Error(w, 400, "bad_request", "Could not read body")
		}
		return false
	}
	if len(bytes.TrimSpace(body)) != 0 {
		Error(w, 400, "bad_request", "This operation has no request body")
		return false
	}
	return true
}

// Decode accepts one strict JSON object. Optional fields may be omitted, but
// nulls, duplicate keys, unknown keys and case aliases are never accepted.
func Decode(w http.ResponseWriter, r *http.Request, destination any, allowed, required []string) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		Error(w, http.StatusBadRequest, "invalid_json", "A JSON object is required")
		return false
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			Error(w, http.StatusRequestEntityTooLarge, "body_too_large", "JSON body exceeds 64 KiB")
		} else {
			Error(w, http.StatusBadRequest, "invalid_json", "Could not read JSON body")
		}
		return false
	}

	return DecodeObject(w, body, destination, allowed, required)
}

// DecodeObject validates a bounded JSON object already read by Decode.
func DecodeObject(w http.ResponseWriter, body []byte, destination any, allowed, required []string) bool {
	if decodeObject(body, destination, allowed, required) {
		return true
	}
	Error(w, http.StatusBadRequest, "invalid_json", "Expected documented JSON fields with non-null values")
	return false
}

func decodeObject(body []byte, destination any, allowed, required []string) bool {
	if !utf8.Valid(body) {
		return false
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return false
	}

	seen := make(map[string]bool, len(allowed))

	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return false
		}
		name, ok := key.(string)
		known := false
		for _, field := range allowed {
			known = known || field == name
		}
		if !ok || !known || seen[name] {
			return false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
		seen[name] = true
	}

	if _, err := decoder.Token(); err != nil {
		return false
	}

	for _, field := range required {
		if !seen[field] {
			return false
		}
	}

	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return false
	}

	if err := json.Unmarshal(body, destination); err != nil {
		return false
	}

	return true
}

func Write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Error(w http.ResponseWriter, status int, code, message string) {
	Write(w, status, struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{code, message})
}
