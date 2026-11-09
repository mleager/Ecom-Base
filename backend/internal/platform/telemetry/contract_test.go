package telemetry_test

import (
	"context"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	otelprometheus "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"

	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/httpserver"
	"ecom/backend/internal/platform/metrics"
)

// contractPath is the published contract, relative to this package.
const contractPath = "../../../../docs/updated/backend/OBSERVABILITY_CONTRACT.md"

// metricRow matches a row of the contract's metrics table:
// | `otel.name` | `prometheus_name` | ...
var metricRow = regexp.MustCompile("^\\|\\s*`([a-z0-9_.]+)`\\s*\\|\\s*`([a-z0-9_]+)`\\s*\\|")

// TestContractListsEveryMetric creates every instrument the API registers,
// through the same constructors main uses, and fails when one is missing from
// OBSERVABILITY_CONTRACT.md, when the contract lists one that no longer
// exists, or when its Prometheus name differs from what the exporter emits.
func TestContractListsEveryMetric(t *testing.T) {
	registered := registeredInstruments(t)
	documented := documentedMetrics(t)

	for _, name := range sortedKeys(registered) {
		promName, ok := documented[name]
		if !ok {
			t.Errorf("metric %s is registered but missing from the contract", name)
			continue
		}
		if want := prometheusName(t, registered[name]); promName != want {
			t.Errorf("contract gives %s the Prometheus name %s; the exporter emits %s", name, promName, want)
		}
	}
	for _, name := range sortedKeys(documented) {
		if _, ok := registered[name]; !ok {
			t.Errorf("contract lists %s, which nothing registers", name)
		}
	}
}

// registeredInstruments records each instrument as the SDK creates it, using
// a view that matches nothing and so changes nothing.
func registeredInstruments(t *testing.T) map[string]sdkmetric.Instrument {
	t.Helper()
	var mu sync.Mutex
	found := map[string]sdkmetric.Instrument{}
	capture := func(i sdkmetric.Instrument) (sdkmetric.Stream, bool) {
		mu.Lock()
		defer mu.Unlock()
		found[i.Name] = i
		return sdkmetric.Stream{}, false
	}
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewManualReader()), sdkmetric.WithView(capture))
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })

	// HTTP server instruments.
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	if _, err := httpserver.NewInstrumented("127.0.0.1:0", func(context.Context) error { return nil }, logger,
		httpserver.Instrumentation{MeterProvider: provider}); err != nil {
		t.Fatal(err)
	}

	// Query and pool instruments. The pool connects lazily, so nothing is dialed.
	pool, err := database.OpenInstrumented(context.Background(), "postgres://contract:contract@127.0.0.1:1/contract?sslmode=disable",
		database.Instrumentation{MeterProvider: provider})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	// Business counters (rate limits, checkout, guest sessions, mail).
	if _, err := metrics.New(provider); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(found) == 0 {
		t.Fatal("no instruments were registered")
	}
	return found
}

// documentedMetrics returns the contract's metrics table as OTel name to
// Prometheus name.
func documentedMetrics(t *testing.T) map[string]string {
	t.Helper()
	contents, err := os.ReadFile(filepath.FromSlash(contractPath))
	if err != nil {
		t.Fatalf("read the contract: %v", err)
	}
	// The table sits between "## Metrics" and the next heading.
	rows := map[string]string{}
	inSection := false
	for _, line := range strings.Split(string(contents), "\n") {
		if strings.HasPrefix(line, "#") {
			inSection = line == "## Metrics"
			continue
		}
		if !inSection {
			continue
		}
		if match := metricRow.FindStringSubmatch(line); match != nil {
			if _, dup := rows[match[1]]; dup {
				t.Errorf("contract lists %s twice", match[1])
			}
			rows[match[1]] = match[2]
		}
	}
	if len(rows) == 0 {
		t.Fatal("the contract has no metrics table rows")
	}
	return rows
}

// prometheusName asks the real Prometheus exporter, configured as telemetry
// configures it, what it calls an instrument of this name, kind and unit.
func prometheusName(t *testing.T, i sdkmetric.Instrument) string {
	t.Helper()
	registry := prometheus.NewRegistry()
	exporter, err := otelprometheus.New(otelprometheus.WithRegisterer(registry), otelprometheus.WithoutScopeInfo())
	if err != nil {
		t.Fatal(err)
	}
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(exporter))
	defer func() { _ = provider.Shutdown(context.Background()) }()

	meter := provider.Meter("contract")
	ctx := context.Background()
	unit := metric.WithUnit(i.Unit)
	switch i.Kind {
	case sdkmetric.InstrumentKindCounter:
		c, err := meter.Int64Counter(i.Name, unit)
		must(t, err)
		c.Add(ctx, 1)
	case sdkmetric.InstrumentKindUpDownCounter:
		c, err := meter.Int64UpDownCounter(i.Name, unit)
		must(t, err)
		c.Add(ctx, 1)
	case sdkmetric.InstrumentKindHistogram:
		h, err := meter.Float64Histogram(i.Name, unit)
		must(t, err)
		h.Record(ctx, 1)
	case sdkmetric.InstrumentKindGauge:
		g, err := meter.Int64Gauge(i.Name, unit)
		must(t, err)
		g.Record(ctx, 1)
	case sdkmetric.InstrumentKindObservableCounter:
		_, err := meter.Int64ObservableCounter(i.Name, unit, metric.WithInt64Callback(observeOne))
		must(t, err)
	case sdkmetric.InstrumentKindObservableUpDownCounter:
		_, err := meter.Int64ObservableUpDownCounter(i.Name, unit, metric.WithInt64Callback(observeOne))
		must(t, err)
	case sdkmetric.InstrumentKindObservableGauge:
		_, err := meter.Int64ObservableGauge(i.Name, unit, metric.WithInt64Callback(observeOne))
		must(t, err)
	default:
		t.Fatalf("instrument %s has a kind this test does not know: %v", i.Name, i.Kind)
	}

	families, err := registry.Gather()
	must(t, err)
	var names []string
	for _, family := range families {
		if family.GetName() != "target_info" {
			names = append(names, family.GetName())
		}
	}
	if len(names) != 1 {
		t.Fatalf("instrument %s exported as %v, want one family", i.Name, names)
	}
	return names[0]
}

func observeOne(_ context.Context, o metric.Int64Observer) error {
	o.Observe(1)
	return nil
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func sortedKeys[V any](m map[string]V) []string {
	return slices.Sorted(maps.Keys(m))
}
