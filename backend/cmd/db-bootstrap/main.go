package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"ecom/backend/internal/dbbootstrapcmd"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := dbbootstrapcmd.Run(ctx, os.Args[1:], os.Getenv, os.Stdout, os.Stderr); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
