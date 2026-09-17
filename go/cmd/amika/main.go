// Package main implements the amika CLI.
package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/gofixpoint/amika/go/internal/cliflags"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:               "amika",
	Short:             "Amika - run coding agents in remote rigs",
	Long:              `Amika creates and manages remote rigs (sandboxes) and runs coding agents inside them.`,
	CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	SilenceUsage:      true,
	SilenceErrors:     true,
	// Validate the global --output flag once, before any command runs, so an
	// invalid value fails consistently even for commands that don't emit JSON.
	// Cobra runs only the most-specific PersistentPreRunE in the chain, so a
	// subcommand that defines its own must call output.FormatFrom (or invoke
	// this hook) to keep --output validated for that subtree.
	PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
		if err := rejectRemovedLocalFlag(cmd); err != nil {
			return err
		}
		_, err := output.FormatFrom(cmd)
		return err
	},
}

// rejectRemovedLocalFlag turns the retired --local into a migration message
// rather than cobra's bare "unknown flag: --local". The flag is still
// registered (hidden) on the command trees that used to offer it, purely so it
// parses and can be reported here; rigs are always remote now.
func rejectRemovedLocalFlag(cmd *cobra.Command) error {
	if f := cmd.Flags().Lookup("local"); f != nil && f.Changed {
		return fmt.Errorf("--local has been removed; rigs are always remote now, so run the command without it")
	}
	return nil
}

func init() {
	rootCmd.Version = versionString()
	rootCmd.SetVersionTemplate("{{.Version}}\n")
	// Keep the retired --sandbox, --sandbox-name, and --sandbox-by spellings
	// pointing at the --rig flags that replaced them. Cobra applies this to the
	// commands already attached here and to every command attached later, so it
	// holds whichever order the package's init functions run in.
	rootCmd.SetGlobalNormalizationFunc(cliflags.NormalizeFlagName)
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
