package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/gofixpoint/wisp/internal/mount"
	"github.com/gofixpoint/wisp/internal/state"
	"github.com/spf13/cobra"
)

var v0Cmd = &cobra.Command{
	Use:   "v0",
	Short: "v0 commands for filesystem mounting and materialization",
	Long:  `v0 provides filesystem mounting and script execution with output materialization. Targets macOS using bindfs and macFUSE.`,
}

var mountCmd = &cobra.Command{
	Use:   "mount <src> <target>",
	Short: "Mount a source directory to a target path",
	Long: `Mount a source directory to a target path with specified access mode.

Modes:
  ro      - Read-only access to source files
  rw      - Read-write access; writes go directly to source
  overlay - Read-write access; writes do not affect source`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		src := args[0]
		target := args[1]
		mode, _ := cmd.Flags().GetString("mode")

		// Convert to absolute paths
		absSrc, err := filepath.Abs(src)
		if err != nil {
			return fmt.Errorf("failed to resolve source path: %w", err)
		}
		absTarget, err := filepath.Abs(target)
		if err != nil {
			return fmt.Errorf("failed to resolve target path: %w", err)
		}

		// Create state manager
		st, err := state.NewStateInHomeDir()
		if err != nil {
			return err
		}

		// Perform mount
		if err := mount.Mount(absSrc, absTarget, mode, st); err != nil {
			fmt.Fprintln(os.Stderr, "Error:", err)
			return err
		}

		fmt.Printf("Mounted %s to %s (mode: %s)\n", absSrc, absTarget, mode)
		return nil
	},
}

var unmountCmd = &cobra.Command{
	Use:   "unmount <target>",
	Short: "Unmount a previously mounted target",
	Long:  `Unmount a previously mounted target and clean up any associated resources.`,
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("unmount: target=%s (not yet implemented)\n", args[0])
	},
}

var materializeCmd = &cobra.Command{
	Use:   "materialize",
	Short: "Run a script and copy output files to a destination",
	Long: `Run a script and copy output files to a destination directory.

This simulates a sandboxed execution model where the script runs in isolation
and its outputs are "materialized" to the host.`,
	Run: func(cmd *cobra.Command, args []string) {
		script, _ := cmd.Flags().GetString("script")
		workdir, _ := cmd.Flags().GetString("workdir")
		outdir, _ := cmd.Flags().GetString("outdir")
		destdir, _ := cmd.Flags().GetString("destdir")
		fmt.Printf("materialize: script=%s workdir=%s outdir=%s destdir=%s (not yet implemented)\n",
			script, workdir, outdir, destdir)
	},
}

func init() {
	// Add v0 command to root
	rootCmd.AddCommand(v0Cmd)

	// Add subcommands to v0
	v0Cmd.AddCommand(mountCmd)
	v0Cmd.AddCommand(unmountCmd)
	v0Cmd.AddCommand(materializeCmd)

	// Mount command flags
	mountCmd.Flags().StringP("mode", "m", "", "Access mode: ro, rw, or overlay (required)")
	mountCmd.MarkFlagRequired("mode")

	// Materialize command flags
	materializeCmd.Flags().String("script", "", "Path to the script to execute (required)")
	materializeCmd.Flags().String("workdir", "", "Working directory for script execution (required)")
	materializeCmd.Flags().String("outdir", "", "Directory where the script writes output files (required)")
	materializeCmd.Flags().String("destdir", "", "Host directory where output files are copied (required)")
	materializeCmd.MarkFlagRequired("script")
	materializeCmd.MarkFlagRequired("workdir")
	materializeCmd.MarkFlagRequired("outdir")
	materializeCmd.MarkFlagRequired("destdir")
}
