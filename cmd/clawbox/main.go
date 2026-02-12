package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "clawbox",
	Short: "Clawbox - filesystem mounting and script execution",
	Long:  `Clawbox provides filesystem mounting and script execution with output materialization.`,
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
