package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"ecom/backend/internal/reconcilecmd"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := reconcilecmd.Run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
