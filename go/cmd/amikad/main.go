// Package main runs the Amika sandbox daemon.
package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/amikad"
)

func main() {
	cmd := amikad.NewCommand(amikad.NewProductionOperations())
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
