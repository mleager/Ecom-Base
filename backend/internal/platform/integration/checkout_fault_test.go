//go:build integration

package integration

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ecom/backend/internal/checkout"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCheckoutRetries(t *testing.T) {
	for _, tc := range []struct {
		name, code         string
		failures, attempts int
		success            bool
		atCommit           bool
	}{
		{"serialization twice", "40001", 2, 3, true, false},
		{"deadlock once", "40P01", 1, 2, true, false},
		{"retry budget exhausted", "40001", 100, 3, false, false},
		{"arbitrary SQL error is not retried", "P0001", 1, 1, false, false},
		{"serialization at commit", "40001", 1, 2, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTestDatabase(t)
			product := seedCheckoutProduct(t, f, 10, 100)
			c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
			// Sequences survive transaction rollback, so they count attempts without
			// adding a production fault switch or mocking PostgreSQL transactions.
			trigger := `CREATE TRIGGER retry_checkout BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION retry_checkout();`
			if tc.atCommit {
				trigger = `CREATE CONSTRAINT TRIGGER retry_checkout AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION retry_checkout();`
			}
			statement := fmt.Sprintf(`CREATE SEQUENCE checkout_attempts;
CREATE FUNCTION retry_checkout() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE attempt bigint;
BEGIN attempt:=nextval('public.checkout_attempts'); IF attempt<=%d THEN RAISE EXCEPTION 'injected aborted transaction' USING ERRCODE='%s'; END IF; RETURN NEW; END $$;
%s`, tc.failures, tc.code, trigger)
			if _, err := f.migrator.Exec(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			result, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "retry-key", c.request)
			if tc.success {
				if err != nil || result.Replayed || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
					t.Fatalf("retry did not create exactly once: %v", err)
				}
			} else {
				var pgError *pgconn.PgError
				if !errors.As(err, &pgError) || pgError.Code != tc.code {
					t.Fatalf("wrong aborted transaction error: %v", err)
				}
				assertCheckoutRolledBack(t, f, c)
			}
			var attempts int
			if err := f.migrator.QueryRow(f.ctx, `SELECT last_value FROM checkout_attempts`).Scan(&attempts); err != nil || attempts != tc.attempts {
				t.Fatalf("attempt count=%d want=%d err=%v", attempts, tc.attempts, err)
			}
			assertCheckoutIntegrity(t, f)
		})
	}
}

type commitFaultMode int

const (
	commitDropBefore commitFaultMode = iota + 1
	commitDropAfter
	commitDelayed
)

// This test-only transport sits between pgx and the actual PostgreSQL socket.
// It changes no business data or transaction API: the service must resolve real
// lost acknowledgements, including a transaction still holding its advisory lock.
type commitFault struct {
	mode      commitFaultMode
	used      atomic.Bool
	seen      atomic.Int32
	target    int32
	release   chan struct{}
	completed chan error
	once      sync.Once
	cancel    context.CancelFunc
}

type commitFaultConn struct {
	net.Conn
	fault    *commitFault
	dropRead atomic.Bool
	detached atomic.Bool
}

func isCommit(packet []byte) bool {
	return len(packet) > 5 && packet[0] == 'Q' && int(binary.BigEndian.Uint32(packet[1:5])) == len(packet)-1 && strings.EqualFold(string(packet[5:]), "commit\x00")
}

func (c *commitFaultConn) Write(packet []byte) (int, error) {
	// A partitioned downstream cannot forward pgx's best-effort cancellation
	// or termination to the detached upstream transaction in the delayed case.
	if c.fault.mode == commitDelayed && c.fault.used.Load() && len(packet) >= 8 && binary.BigEndian.Uint32(packet[4:8]) == 80877102 {
		// Close the discarded cancellation socket promptly; otherwise pgx waits
		// for its cancellation timeout during pool cleanup despite the test ending.
		_ = c.Conn.Close()
		return len(packet), nil
	}
	if c.detached.Load() {
		return len(packet), nil
	}
	if !isCommit(packet) || c.fault.used.Load() {
		return c.Conn.Write(packet)
	}
	target := c.fault.target
	if target == 0 {
		target = 1
	}
	if c.fault.seen.Add(1) != target || !c.fault.used.CompareAndSwap(false, true) {
		return c.Conn.Write(packet)
	}
	switch c.fault.mode {
	case commitDropBefore:
		_ = c.Conn.Close()
		c.fault.completed <- nil
		return 0, net.ErrClosed
	case commitDropAfter:
		c.dropRead.Store(true)
		return c.Conn.Write(packet)
	case commitDelayed:
		c.detached.Store(true)
		c.dropRead.Store(true)
		pending := append([]byte(nil), packet...)
		go func() {
			<-c.fault.release
			_ = c.Conn.SetDeadline(time.Now().Add(5 * time.Second))
			_, err := c.Conn.Write(pending)
			if err == nil {
				err = drainCommit(c.Conn)
			}
			_ = c.Conn.Close()
			c.detached.Store(false)
			c.fault.completed <- err
		}()
		return len(packet), nil
	default:
		return 0, fmt.Errorf("unrecognized commit fault mode %d", c.fault.mode)
	}
}

func (c *commitFaultConn) Read(buffer []byte) (int, error) {
	if c.dropRead.CompareAndSwap(true, false) {
		if c.fault.mode == commitDropAfter {
			err := drainCommit(c.Conn)
			_ = c.Conn.Close()
			c.fault.completed <- err
			if c.fault.cancel != nil {
				c.fault.cancel()
			}
		}
		return 0, io.ErrUnexpectedEOF
	}
	if c.detached.Load() {
		return 0, io.ErrUnexpectedEOF
	}
	return c.Conn.Read(buffer)
}

func (c *commitFaultConn) Close() error {
	if c.detached.Load() {
		return nil
	}
	return c.Conn.Close()
}

func drainCommit(connection net.Conn) error {
	frontend := pgproto3.NewFrontend(connection, connection)
	committed := false
	for {
		message, err := frontend.Receive()
		if err != nil {
			return err
		}
		switch m := message.(type) {
		case *pgproto3.CommandComplete:
			committed = string(m.CommandTag) == "COMMIT"
		case *pgproto3.ReadyForQuery:
			if !committed || m.TxStatus != 'I' {
				return errors.New("fault transport did not observe committed transaction")
			}
			return nil
		case *pgproto3.ErrorResponse:
			return fmt.Errorf("server rejected injected commit: SQLSTATE %s", m.Code)
		case *pgproto3.NoticeResponse, *pgproto3.ParameterStatus, *pgproto3.NotificationResponse:
			// Asynchronous informational messages may precede ReadyForQuery.
		default:
			return fmt.Errorf("unexpected PostgreSQL commit message %T", message)
		}
	}
}

func newCommitFaultPool(t *testing.T, f *testDatabase, mode commitFaultMode) (*pgxpool.Pool, *commitFault) {
	t.Helper()
	fault := &commitFault{mode: mode, release: make(chan struct{}), completed: make(chan error, 1)}
	config := f.pool.Config()
	dial := config.ConnConfig.DialFunc
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		connection, err := dial(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &commitFaultConn{Conn: connection, fault: fault}, nil
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fault.once.Do(func() { close(fault.release) }); pool.Close() })
	return pool, fault
}

func awaitCommitFault(t *testing.T, fault *commitFault) {
	t.Helper()
	select {
	case err := <-fault.completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("test commit transport did not complete")
	}
}

func TestCheckoutCommitUncertainty(t *testing.T) {
	t.Run("lost reply after actual commit resolves known order", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		pool, fault := newCommitFaultPool(t, f, commitDropAfter)
		result, err := checkout.NewService(pool).CreatePending(f.ctx, c.user, "lost-ack", c.request)
		if err != nil || !result.Replayed || result.Order.Status != "pending_payment" || !fault.used.Load() {
			t.Fatalf("committed outcome not resolved: %v", err)
		}
		awaitCommitFault(t, fault)
		retry, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "lost-ack", c.request)
		if err != nil || !retry.Replayed || retry.Order.ID != result.Order.ID || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatalf("retry duplicated known commit: %v", err)
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("resolution survives request cancellation", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		pool, fault := newCommitFaultPool(t, f, commitDropAfter)
		ctx, cancel := context.WithCancel(f.ctx)
		defer cancel()
		fault.cancel = cancel
		result, err := checkout.NewService(pool).CreatePending(ctx, c.user, "cancelled-ack", c.request)
		if err != nil || !result.Replayed || ctx.Err() == nil || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatalf("cancelled request lost known durable result: %v", err)
		}
		awaitCommitFault(t, fault)
		assertCheckoutIntegrity(t, f)
	})

	t.Run("lost connection before server commit remains uncertain", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		pool, fault := newCommitFaultPool(t, f, commitDropBefore)
		if _, err := checkout.NewService(pool).CreatePending(f.ctx, c.user, "lost-before", c.request); !errors.Is(err, checkout.ErrOutcomeUncertain) || !fault.used.Load() {
			t.Fatalf("missing acknowledgement incorrectly claimed certainty: %v", err)
		}
		awaitCommitFault(t, fault)
		assertCheckoutRolledBack(t, f, c)
		result, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "lost-before", c.request)
		if err != nil || result.Replayed || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatalf("same-key retry after rollback failed: %v", err)
		}
		assertCheckoutIntegrity(t, f)
	})

	t.Run("in flight commit is not mistaken for rollback", func(t *testing.T) {
		f := newTestDatabase(t)
		product := seedCheckoutProduct(t, f, 10, 100)
		c := seedCheckoutCustomer(t, f, checkoutLine{product, 1})
		pool, fault := newCommitFaultPool(t, f, commitDelayed)
		if _, err := checkout.NewService(pool).CreatePending(f.ctx, c.user, "in-flight", c.request); !errors.Is(err, checkout.ErrOutcomeUncertain) || !fault.used.Load() {
			t.Fatalf("in-flight outcome incorrectly claimed certainty: %v", err)
		}
		if checkoutCounts(t, f) != [6]int{} {
			t.Fatal("uncommitted rows became visible")
		}
		fault.once.Do(func() { close(fault.release) })
		awaitCommitFault(t, fault)
		result, err := checkout.NewService(f.pool).CreatePending(f.ctx, c.user, "in-flight", c.request)
		if err != nil || !result.Replayed || checkoutCounts(t, f) != [6]int{1, 1, 1, 1, 1, 1} {
			t.Fatalf("late commit duplicated or lost order: %v", err)
		}
		assertCheckoutIntegrity(t, f)
	})
}
