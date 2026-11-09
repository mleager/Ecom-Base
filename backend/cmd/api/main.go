package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/platform/httpserver"
	"ecom/backend/internal/platform/telemetry"
)

// shutdownTimeout bounds the graceful shutdown, including the final telemetry flush.
const shutdownTimeout = 10 * time.Second

func main() {
	// LogHandler adds trace_id and span_id when a span is active; otherwise
	// the JSON lines are unchanged.
	logger := slog.New(telemetry.LogHandler(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(logger); err != nil {
		logger.Error("API stopped", "error", err.Error())
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	c, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}

	// Check the frontend directory before connecting to anything.
	var spa []func(chi.Router)
	if c.StaticDir != "" {
		static, err := httpserver.Static(c.StaticDir)
		if err != nil {
			return err
		}
		spa = append(spa, httpserver.SPA(static))
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Off unless OTEL_* or METRICS_ADDR is set; see platform/telemetry.
	tel, err := telemetry.Start(ctx, telemetry.Settings{MetricsAddress: c.MetricsAddress, Logger: logger})
	if err != nil {
		return err
	}
	// Covers early returns. After a graceful shutdown this is a no-op.
	defer func() {
		flush, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := tel.Shutdown(flush); err != nil {
			logger.Warn("telemetry shutdown incomplete")
		}
	}()

	pool, err := database.OpenInstrumented(ctx, c.DatabaseURL, database.Instrumentation{TracerProvider: tel.TracerProvider, MeterProvider: tel.MeterProvider})
	if err != nil {
		return err
	}
	defer pool.Close()

	sender, err := email.New(c.Mail)
	if err != nil {
		return err
	}

	authentication, err := auth.NewService(pool, c.JWTSecret, time.Now, auth.SecurityOptions{Sender: sender, Origin: c.FrontendOrigin})
	if err != nil {
		return err
	}

	authHTTP := auth.NewHandler(authentication, auth.HTTPOptions{Origin: c.FrontendOrigin, SecureCookies: c.SecureCookies(), Logger: logger})

	commerceHTTP := commerce.NewHandler(commerce.NewService(pool), authHTTP.Authenticate)

	guestHTTP := commerce.NewGuestHandler(commerce.NewService(pool), authHTTP.Authenticate, auth.HTTPOptions{Origin: c.FrontendOrigin, SecureCookies: c.SecureCookies()})

	checkoutService := checkout.NewService(pool)
	checkoutHTTP := checkout.NewHandler(checkoutService, authHTTP.Authenticate, logger)
	guestCheckout := checkout.NewGuestHandler(checkout.NewGuestService(checkoutService, sender, c.FrontendOrigin), guestHTTP, c.SecureCookies())

	// The SPA fallback, when enabled, must be the last mount.
	routes := append([]func(chi.Router){authHTTP.RoutesWith(commerceHTTP.Routes, checkoutHTTP.Routes, guestHTTP.Routes, guestCheckout.Routes)}, spa...)
	instrumentation := httpserver.Instrumentation{TracerProvider: tel.TracerProvider, MeterProvider: tel.MeterProvider, Propagator: tel.Propagator}
	server, err := httpserver.NewInstrumented(c.HTTPAddress, func(ctx context.Context) error { return database.Ready(ctx, pool) }, logger, instrumentation, routes...)
	if err != nil {
		return err
	}

	if c.TLSEnabled() {
		if err := httpserver.EnableTLS(server, c.TLSCertFile, c.TLSKeyFile); err != nil {
			return err
		}
	}
	if c.HSTS() {
		server.Handler = httpserver.HSTS(server.Handler)
	}
	// Route the server's own messages (for example TLS handshake failures) to the JSON log.
	server.ErrorLog = slog.NewLogLogger(logger.Handler(), slog.LevelWarn)

	serverErrors := make(chan error, 1)

	go func() {
		if c.TLSEnabled() {
			serverErrors <- server.ListenAndServeTLS("", "")
			return
		}
		serverErrors <- server.ListenAndServe()
	}()

	logger.Info("API starting", "address", c.HTTPAddress, "tls", c.TLSEnabled(), "static", c.StaticDir != "")

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP listener failed")
		}
		return nil
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return errors.New("HTTP shutdown exceeded its deadline")
		}
		// Flush spans from the finished requests within the same deadline.
		// The deferred call above reports the result once.
		_ = tel.Shutdown(shutdown)
		return nil
	}
}
