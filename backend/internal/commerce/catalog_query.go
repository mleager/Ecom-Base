package commerce

import "net/url"

type productQuery struct {
	limit, offset int64
	search        string
	isActive      *bool
}

// Only catalog lists accept these extra keys. Order pagination retains the
// shared parser's strict limit/offset grammar.
func parseProductQuery(raw string, admin bool) (productQuery, error) {
	query, err := url.ParseQuery(raw)
	if err != nil {
		return productQuery{}, errQuery
	}
	for key, values := range query {
		if len(values) != 1 || (key != "limit" && key != "offset" && key != "q" && !(key == "is_active" && admin)) {
			return productQuery{}, errQuery
		}
	}

	result := productQuery{search: query.Get("q")}
	if _, err := productSearchPattern(result.search); err != nil {
		return productQuery{}, err
	}

	if value, exists := query["is_active"]; exists {
		if value[0] != "true" && value[0] != "false" {
			return productQuery{}, errQuery
		}
		active := value[0] == "true"
		result.isActive = &active
	}

	query.Del("q")
	query.Del("is_active")

	result.limit, result.offset, err = pagination(query.Encode())
	if err != nil {
		return productQuery{}, err
	}

	return result, nil
}
