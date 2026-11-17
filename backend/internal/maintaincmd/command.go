// Package maintaincmd runs the migrator-only data maintenance in
// backend/maintenance as an operator command (M17 task 8).
package maintaincmd

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"time"

	"ecom/backend"
	"ecom/backend/internal/platform/config"

	"github.com/jackc/pgx/v5"
)

const usage = `Usage: maintain guests [--max-batches N]

  guests  remove guests whose sessions expired at least 7 days ago, with
          their carts and cart choices; expire overdue checkout intents
          (scrubbing contact and shipping); and remove recovery proofs and
          grants 7 days after they expired. Guests with an order or a
          checkout intent are kept.

Each batch changes at most 500 rows per table in one transaction with a
5-second deadline. Batches repeat until one changes nothing, or until
--max-batches (default 20, at most 1000).

Environment: APP_ENV (local or production) and DATABASE_URL (migrator
credentials; the SQL refuses any other role). Output is JSON lines on
standard output. The database URL is never printed.
`

const batchTimeout = 5 * time.Second

// Batch is one output line per batch: rows changed by each statement type.
type Batch struct {
	Event   string `json:"event"`
	Batch   int    `json:"batch"`
	Deleted int64  `json:"deleted"`
	Updated int64  `json:"updated"`
}

// Summary is the last line of a run.
type Summary struct {
	Event    string `json:"event"`
	Batches  int    `json:"batches"`
	Deleted  int64  `json:"deleted"`
	Updated  int64  `json:"updated"`
	Complete bool   `json:"complete"`
}

// Parse accepts "guests" and an optional --max-batches.
func Parse(args []string, help io.Writer) (int, error) {
	if len(args) == 1 {
		switch args[0] {
		case "-h", "-help", "--help", "help":
			_, _ = io.WriteString(help, usage)
			return 0, flag.ErrHelp
		}
	}
	if len(args) == 0 || args[0] != "guests" {
		return 0, errors.New("expected the guests command; use maintain --help")
	}

	flags := flag.NewFlagSet("maintain guests", flag.ContinueOnError)
	// Flag errors may echo their input, so they are replaced by static text.
	flags.SetOutput(io.Discard)
	batches := flags.Int("max-batches", 20, "Maximum batches (1-1000)")
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, _ = io.WriteString(help, usage)
			return 0, flag.ErrHelp
		}
		return 0, errors.New("invalid flags; use maintain --help")
	}
	if flags.NArg() != 0 || *batches < 1 || *batches > 1000 {
		return 0, errors.New("expected no other arguments and --max-batches between 1 and 1000")
	}
	return *batches, nil
}

// Run reads only explicit process configuration and never loads .env.
func Run(ctx context.Context, args []string, getenv func(string) string, output, help io.Writer) error {
	return RunSQL(ctx, backend.GuestMaintenance, args, getenv, output, help)
}

// RunSQL is Run with other batch SQL; tests use it.
func RunSQL(ctx context.Context, batchSQL string, args []string, getenv func(string) string, output, help io.Writer) error {
	maxBatches, err := Parse(args, help)
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
	c, err := pgx.ParseConfig(connectionURL)
	if err != nil {
		return errors.New("invalid PostgreSQL connection configuration")
	}
	c.ConnectTimeout = 5 * time.Second
	c.RuntimeParams["timezone"] = "UTC"
	if c.RuntimeParams["application_name"] == "" {
		c.RuntimeParams["application_name"] = "ecom-maintain"
	}

	connect, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := pgx.ConnectConfig(connect, c)
	cancel()
	if err != nil {
		return errors.New("could not connect to PostgreSQL")
	}
	defer func() { _ = conn.Close(context.Background()) }()

	encoder := json.NewEncoder(output)
	summary := Summary{Event: "summary"}
	for summary.Batches < maxBatches {
		batch, err := runBatch(ctx, conn, batchSQL)
		if err != nil {
			_ = encoder.Encode(summary)
			if ctx.Err() != nil {
				return errors.New("maintenance interrupted; committed batches are kept, rerun to continue")
			}
			return errors.New("maintenance batch failed and rolled back; committed batches are kept")
		}
		summary.Batches++
		batch.Batch = summary.Batches
		summary.Deleted += batch.Deleted
		summary.Updated += batch.Updated
		if err := encoder.Encode(batch); err != nil {
			return err
		}
		if batch.Deleted == 0 && batch.Updated == 0 {
			summary.Complete = true
			break
		}
	}
	return encoder.Encode(summary)
}

// runBatch sends the script as one simple-protocol query, so its BEGIN and
// COMMIT bracket every statement, and sums the command tags.
func runBatch(ctx context.Context, conn *pgx.Conn, batchSQL string) (Batch, error) {
	ctx, cancel := context.WithTimeout(ctx, batchTimeout)
	defer cancel()

	results, err := conn.PgConn().Exec(ctx, batchSQL).ReadAll()
	if err != nil {
		return Batch{}, err
	}
	batch := Batch{Event: "batch"}
	for _, result := range results {
		if result.Err != nil {
			return Batch{}, result.Err
		}
		switch tag := result.CommandTag; {
		case tag.Delete():
			batch.Deleted += tag.RowsAffected()
		case tag.Update():
			batch.Updated += tag.RowsAffected()
		}
	}
	return batch, nil
}
