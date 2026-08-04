// Package main runs the Amika sandbox daemon.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/gofixpoint/amika/go/internal/amikad"
)

func main() {
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	cmd := amikad.NewCommand(amikad.NewProductionOperations())
	if err := cmd.ExecuteContext(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
