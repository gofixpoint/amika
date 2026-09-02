// Package main implements the experimental amikalyze frozen-path CLI.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "amikalyze",
	Short: "Enforce frozen paths for coding agents (labs)",
	Long: `Amikalyze is an experimental coding-agent guardrail. It discovers
.amikalyze.toml files between a target path and the active Git worktree root,
then blocks native agent edit tools that target a matching frozen path.`,
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
	return buildmeta.New("amikalyze", buildmeta.MustParseSemVer("dev")).String()
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
