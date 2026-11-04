package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"ecom/backend/internal/fixturecmd"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	root, err := os.Getwd()
	if err == nil {
		err = fixturecmd.Run(ctx, root, os.Args[1:], os.Getenv, os.Stdout)
	}
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
