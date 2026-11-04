package checkout

import (
	"context"
)

type Decision string

const (
	Accepted Decision = "accepted"
	Rejected Decision = "rejected"
)

// Attempt contains only immutable persisted simulator inputs, not client prices
// or card information. Its ID is also the persisted simulator reference.
type Attempt struct {
	ID       string
	Scenario string
}

type Simulator interface {
	Evaluate(context.Context, Attempt) (Decision, error)
}

type LocalSimulator struct{}

func (LocalSimulator) Evaluate(ctx context.Context, attempt Attempt) (Decision, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	id, err := parseID(attempt.ID)
	if err != nil || id.String() != attempt.ID || id.Bytes[6]>>4 != 4 || id.Bytes[8]>>6 != 2 {
		return "", ErrIntegrity
	}

	switch attempt.Scenario {
	case "accept":
		return Accepted, nil
	case "reject":
		return Rejected, nil
	default:
		return "", ErrIntegrity
	}
}
