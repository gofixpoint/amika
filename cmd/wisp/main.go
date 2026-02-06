package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "wisp",
	Short: "Wisp - filesystem mounting and script execution",
	Long:  `Wisp provides filesystem mounting and script execution with output materialization.`,
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
