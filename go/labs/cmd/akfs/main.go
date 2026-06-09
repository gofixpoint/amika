// Package main implements the akfs CLI, an experimental Amika filesystem tool.
//
// akfs is part of the labs subtree (go/labs) and is unstable: commands, flags,
// and behavior may change or be removed at any time. See go/labs/README.md.
package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "akfs",
	Short: "akfs - experimental Amika filesystem tooling (labs)",
	Long: `akfs is an experimental, unstable Amika filesystem tool.

It lives under go/labs and carries no compatibility guarantees; commands and
APIs may change or disappear at any time.`,
	CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	SilenceUsage:      true,
	SilenceErrors:     true,
}

func init() {
	rootCmd.Version = versionString()
	rootCmd.SetVersionTemplate("{{.Version}}\n")
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
	return buildmeta.New("akfs", buildmeta.MustParseSemVer("dev")).String()
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
