package commerce

import (
	"context"
	"regexp"
	"strings"

	"ecom/backend/internal/auth"
	db "ecom/backend/internal/db/sqlc"
)

type ProfilePatch struct {
	FirstName *string `json:"first_name"`
	LastName  *string `json:"last_name"`
}

func (s *Service) UpdateProfile(ctx context.Context, userID string, input ProfilePatch) (auth.User, error) {
	id, err := parseID(userID)
	if err != nil {
		return auth.User{}, err
	}

	if (input.FirstName == nil && input.LastName == nil) || !normalizeText(input.FirstName, 200, true) || !normalizeText(input.LastName, 200, true) {
		return auth.User{}, ErrInvalidInput
	}

	row, err := s.queries.UpdateProfile(ctx, db.UpdateProfileParams{
		ID:        id,
		FirstName: text(input.FirstName),
		LastName:  text(input.LastName),
	})
	if err != nil {
		return auth.User{}, found(err)
	}

	return auth.User{
		ID:            idString(row.ID),
		FirstName:     row.FirstName,
		LastName:      row.LastName,
		Email:         row.Email,
		Role:          row.Role,
		CreatedAt:     row.CreatedAt.Time,
		EmailVerified: row.EmailVerifiedAt.Valid,
	}, nil
}

type Address struct {
	ID            string `json:"id"`
	Label         string `json:"label"`
	RecipientName string `json:"recipient_name"`
	Line1         string `json:"line_1"`
	Line2         string `json:"line_2"`
	City          string `json:"city"`
	Region        string `json:"region"`
	PostalCode    string `json:"postal_code"`
	CountryCode   string `json:"country_code"`
}

type AddressInput struct {
	Label         *string `json:"label"`
	RecipientName *string `json:"recipient_name"`
	Line1         *string `json:"line_1"`
	Line2         *string `json:"line_2"`
	City          *string `json:"city"`
	Region        *string `json:"region"`
	PostalCode    *string `json:"postal_code"`
	CountryCode   *string `json:"country_code"`
}

var zipPattern = regexp.MustCompile(`^[0-9]{5}(-[0-9]{4})?$`)

const states = " AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY "

func (a *AddressInput) valid(create bool) bool {
	if create && (a.RecipientName == nil || a.Line1 == nil || a.City == nil || a.Region == nil || a.PostalCode == nil) {
		return false
	}

	if !create && a.Label == nil && a.RecipientName == nil && a.Line1 == nil && a.Line2 == nil && a.City == nil && a.Region == nil && a.PostalCode == nil {
		return false
	}

	if !normalizeText(a.Label, 80, false) || !normalizeText(a.RecipientName, 200, true) || !normalizeText(a.Line1, 200, true) || !normalizeText(a.Line2, 200, false) || !normalizeText(a.City, 100, true) || !normalizeText(a.Region, 2, true) || !normalizeText(a.PostalCode, 10, true) {
		return false
	}

	if a.CountryCode != nil && (!create || *a.CountryCode != "US") {
		return false
	}

	if a.Region != nil {
		*a.Region = strings.ToUpper(*a.Region)
		if len(*a.Region) != 2 || !strings.Contains(states, " "+*a.Region+" ") {
			return false
		}
	}

	return a.PostalCode == nil || zipPattern.MatchString(*a.PostalCode)
}

func addressView(row db.Address) Address {
	return Address{
		ID:            idString(row.ID),
		Label:         row.Label.String,
		RecipientName: row.RecipientName,
		Line1:         row.Line1,
		Line2:         row.Line2.String,
		City:          row.City,
		Region:        row.Region,
		PostalCode:    row.PostalCode,
		CountryCode:   row.CountryCode,
	}
}

// NormalizeShippingAddress reuses saved-address validation for a trusted database
// read before taking an immutable order snapshot. It does not modify the caller.
func NormalizeShippingAddress(address Address) (Address, error) {
	input := AddressInput{
		Label:         &address.Label,
		RecipientName: &address.RecipientName,
		Line1:         &address.Line1,
		Line2:         &address.Line2,
		City:          &address.City,
		Region:        &address.Region,
		PostalCode:    &address.PostalCode,
		CountryCode:   &address.CountryCode,
	}

	if !input.valid(true) {
		return Address{}, ErrInvalidInput
	}

	return address, nil
}

func (s *Service) ListAddresses(ctx context.Context, userID string) ([]Address, error) {
	id, err := parseID(userID)
	if err != nil {
		return nil, err
	}

	rows, err := s.queries.ListAddresses(ctx, id)
	if err != nil {
		return nil, err
	}

	result := make([]Address, 0, len(rows))
	for _, row := range rows {
		result = append(result, addressView(row))
	}

	return result, nil
}

func (s *Service) CreateAddress(ctx context.Context, userID string, input AddressInput) (Address, error) {
	user, err := parseID(userID)
	if err != nil {
		return Address{}, err
	}

	if !input.valid(true) {
		return Address{}, ErrInvalidInput
	}

	id, err := newID()
	if err != nil {
		return Address{}, err
	}

	row, err := s.queries.CreateAddress(ctx, db.CreateAddressParams{
		ID:            id,
		UserID:        user,
		Label:         optionalText(input.Label),
		RecipientName: *input.RecipientName,
		Line1:         *input.Line1,
		Line2:         optionalText(input.Line2),
		City:          *input.City,
		Region:        *input.Region,
		PostalCode:    *input.PostalCode,
	})

	return addressView(row), err
}

func (s *Service) UpdateAddress(ctx context.Context, userID, addressID string, input AddressInput) (Address, error) {
	user, err := parseID(userID)
	if err != nil {
		return Address{}, err
	}

	id, err := parseID(addressID)
	if err != nil {
		return Address{}, err
	}

	if !input.valid(false) {
		return Address{}, ErrInvalidInput
	}

	row, err := s.queries.UpdateAddress(ctx, db.UpdateAddressParams{
		ID:            id,
		UserID:        user,
		SetLabel:      input.Label != nil,
		Label:         optionalText(input.Label),
		RecipientName: text(input.RecipientName),
		Line1:         text(input.Line1),
		SetLine2:      input.Line2 != nil,
		Line2:         optionalText(input.Line2),
		City:          text(input.City),
		Region:        text(input.Region),
		PostalCode:    text(input.PostalCode),
	})

	return addressView(row), found(err)
}

func (s *Service) DeleteAddress(ctx context.Context, userID, addressID string) error {
	user, err := parseID(userID)
	if err != nil {
		return err
	}

	id, err := parseID(addressID)
	if err != nil {
		return err
	}

	count, err := s.queries.DeleteAddress(ctx, db.DeleteAddressParams{ID: id, UserID: user})
	if err == nil && count == 0 {
		return ErrNotFound
	}

	return err
}
