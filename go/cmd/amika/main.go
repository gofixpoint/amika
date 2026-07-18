// Package main implements the amika CLI.
package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:               "amika",
	Short:             "Amika - filesystem mounting and script execution",
	Long:              `Amika provides filesystem mounting and script execution with output materialization.`,
	CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	SilenceUsage:      true,
	SilenceErrors:     true,
	// Validate the global --output flag once, before any command runs, so an
	// invalid value fails consistently even for commands that don't emit JSON.
	PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
		_, err := output.FormatFrom(cmd)
		return err
	},
}

func init() {
	rootCmd.Version = versionString()
	rootCmd.SetVersionTemplate("{{.Version}}\n")
	output.AddFlag(rootCmd)
	rootCmd.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print version information",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			fmt.Fprintln(cmd.OutOrStdout(), versionString())
		},
	})
}

func versionString() string {
	return buildmeta.New("amika", buildmeta.AmikaVersion).String()
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
