package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:                "amika",
	Short:              "Amika - filesystem mounting and script execution",
	Long:               `Amika provides filesystem mounting and script execution with output materialization.`,
	CompletionOptions:  cobra.CompletionOptions{HiddenDefaultCmd: true},
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
