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

	"ecom/backend/internal/auth"
	"ecom/backend/internal/checkout"
	"ecom/backend/internal/commerce"
	"ecom/backend/internal/platform/config"
	"ecom/backend/internal/platform/database"
	"ecom/backend/internal/platform/email"
	"ecom/backend/internal/platform/httpserver"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := database.Open(ctx, c.DatabaseURL)
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

	authHTTP := auth.NewHandler(authentication, auth.HTTPOptions{Origin: c.FrontendOrigin, SecureCookies: c.Environment == "production", Logger: logger})

	commerceHTTP := commerce.NewHandler(commerce.NewService(pool), authHTTP.Authenticate)

	guestHTTP := commerce.NewGuestHandler(commerce.NewService(pool), authHTTP.Authenticate, auth.HTTPOptions{Origin: c.FrontendOrigin, SecureCookies: c.Environment == "production"})

	checkoutService := checkout.NewService(pool)
	checkoutHTTP := checkout.NewHandler(checkoutService, authHTTP.Authenticate, logger)
	guestCheckout := checkout.NewGuestHandler(checkout.NewGuestService(checkoutService, sender, c.FrontendOrigin), guestHTTP, c.Environment == "production")

	server := httpserver.New(c.HTTPAddress, func(ctx context.Context) error { return database.Ready(ctx, pool) }, logger, authHTTP.RoutesWith(commerceHTTP.Routes, checkoutHTTP.Routes, guestHTTP.Routes, guestCheckout.Routes))

	serverErrors := make(chan error, 1)

	go func() {
		serverErrors <- server.ListenAndServe()
	}()

	logger.Info("API starting", "address", c.HTTPAddress)

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP listener failed")
		}
		return nil
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return errors.New("HTTP shutdown exceeded its deadline")
		}
		return nil
	}
}
