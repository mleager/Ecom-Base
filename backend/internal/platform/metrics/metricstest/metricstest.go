// Package metricstest reads counters from an in-memory OpenTelemetry reader
// for tests.
package metricstest

import (
	"context"
	"sort"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"ecom/backend/internal/platform/metrics"
)

// New returns a recorder backed by a manual reader.
func New(t testing.TB) (*metrics.Recorder, *sdkmetric.ManualReader, metric.MeterProvider) {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	recorder, err := metrics.New(provider)
	if err != nil {
		t.Fatal(err)
	}
	return recorder, reader, provider
}

// Counters returns every int64 counter point keyed as
// name{key=value,...} with keys sorted, for example
// ecom.rate_limit.rejections{limiter.name=auth_ip,limiter.reason=throttled}.
func Counters(t testing.TB, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatal(err)
	}
	found := map[string]int64{}
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			for _, point := range sum.DataPoints {
				var labels []string
				for _, kv := range point.Attributes.ToSlice() {
					labels = append(labels, string(kv.Key)+"="+kv.Value.Emit())
				}
				sort.Strings(labels)
				found[m.Name+"{"+strings.Join(labels, ",")+"}"] = point.Value
			}
		}
	}
	return found
}
