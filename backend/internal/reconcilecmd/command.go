// Package reconcilecmd adapts the explicit operator command to checkout recovery.
package reconcilecmd

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"time"

	"ecom/backend/internal/checkout"
	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"
)

func Parse(args []string, help io.Writer) (checkout.RecoveryOptions, error) {
	flags := flag.NewFlagSet("reconcile", flag.ContinueOnError)
	// Flag errors may contain arbitrary user-supplied values. Only explicit help
	// goes to the caller; operational errors use static, credential-free messages.
	flags.SetOutput(io.Discard)
	dryRun := flags.Bool("dry-run", false, "Inspect eligible orders without writes (default)")
	apply := flags.Bool("apply", false, "Recover eligible orders using stored simulator outcomes")
	limit := flags.Int("limit", 100, "Maximum visited candidates (1-1000)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			flags.SetOutput(help)
			flags.PrintDefaults()
			return checkout.RecoveryOptions{}, flag.ErrHelp
		}
		return checkout.RecoveryOptions{}, errors.New("invalid flags; use reconcile --help")
	}
	if flags.NArg() != 0 || *limit < 1 || *limit > 1000 {
		return checkout.RecoveryOptions{}, errors.New("expected no positional arguments and --limit between 1 and 1000")
	}
	// Reject specifying both modes even when one is explicitly set to false.
	modes := 0
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "dry-run" || f.Name == "apply" {
			modes++
		}
	})
	if modes > 1 || (*dryRun && *apply) {
		return checkout.RecoveryOptions{}, errors.New("choose only one of --dry-run or --apply")
	}
	return checkout.RecoveryOptions{Apply: *apply, Limit: *limit}, nil
}

// Run reads explicit process configuration. It never loads .env, migrates a
// database or uses administrator credentials automatically. Output is JSONL.
func Run(ctx context.Context, args []string, getenv func(string) string, output, help io.Writer) error {
	options, err := Parse(args, help)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	connectionURL := getenv("DATABASE_URL")
	if err := config.ValidateDatabase(getenv("APP_ENV"), connectionURL); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	pool, err := database.Open(ctx, connectionURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	ready, stop := context.WithTimeout(ctx, 5*time.Second)
	err = database.Ready(ready, pool)
	stop()
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	emit := func(event checkout.RecoveryEvent) error { return encoder.Encode(event) }
	service := checkout.NewService(pool)
	operation := service.InspectRecovery
	if options.Apply {
		operation = service.Recover
	}
	report, runErr := operation(ctx, options.Limit, emit)
	if err := encoder.Encode(struct {
		Event string `json:"event"`
		checkout.RecoveryReport
	}{"summary", report}); err != nil {
		return checkout.ErrRecoveryOutput
	}
	if runErr == nil || errors.Is(runErr, checkout.ErrRecoveryIssues) || errors.Is(runErr, checkout.ErrRecoveryOutput) {
		return runErr
	}
	if ctx.Err() != nil {
		return errors.New("recovery interrupted or run deadline exceeded; inspect state before rerunning")
	}
	return errors.New("recovery database operation failed; inspect state before rerunning")
}
