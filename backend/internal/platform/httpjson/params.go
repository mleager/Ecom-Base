package httpjson

import (
	"errors"
	"net/url"
	"strconv"
)

var (
	ErrPagination       = errors.New("malformed pagination")
	ErrPaginationBounds = errors.New("pagination out of bounds")
)

// Pagination is shared by catalog and order lists so their HTTP grammar and
// PostgreSQL BIGINT bounds stay identical.
func Pagination(raw string) (int64, int64, error) {
	query, err := url.ParseQuery(raw)
	if err != nil {
		return 0, 0, ErrPagination
	}

	for key, values := range query {
		if (key != "limit" && key != "offset") || len(values) != 1 {
			return 0, 0, ErrPagination
		}
	}

	integer := func(key string, fallback int64) (int64, error) {
		values, exists := query[key]
		if !exists {
			return fallback, nil
		}
		value, err := strconv.ParseInt(values[0], 10, 64)
		if errors.Is(err, strconv.ErrRange) {
			return 0, ErrPaginationBounds
		}
		if err != nil {
			return 0, ErrPagination
		}
		return value, nil
	}

	limit, err := integer("limit", 20)
	if err != nil {
		return 0, 0, err
	}

	offset, err := integer("offset", 0)
	if err != nil {
		return 0, 0, err
	}

	if limit < 1 || limit > 100 || offset < 0 {
		return 0, 0, ErrPaginationBounds
	}

	return limit, offset, nil
}
