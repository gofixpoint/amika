// Package main implements the amikactl CLI, the in-sandbox companion to amika.
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:               "amikactl",
	Short:             "Amika in-sandbox control CLI",
	Long:              `amikactl runs inside an Amika sandbox and reports on its identity and contents.`,
	CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	SilenceUsage:      true,
	SilenceErrors:     true,
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
