package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/gofixpoint/clawbox/internal/materialize"
	"github.com/gofixpoint/clawbox/internal/mount"
	"github.com/gofixpoint/clawbox/internal/state"
	"github.com/spf13/cobra"
)

var v0Cmd = &cobra.Command{
	Use:    "v0",
	Short:  "v0 commands for filesystem mounting and materialization",
	Long:   `v0 provides filesystem mounting and script execution with output materialization. Targets macOS using bindfs and macFUSE.`,
	Hidden: true,
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
	RunE: func(cmd *cobra.Command, args []string) error {
		target := args[0]

		// Convert to absolute path
		absTarget, err := filepath.Abs(target)
		if err != nil {
			return fmt.Errorf("failed to resolve target path: %w", err)
		}

		// Create state manager
		st, err := state.NewStateInHomeDir()
		if err != nil {
			return err
		}

		// Perform unmount
		if err := mount.Unmount(absTarget, st); err != nil {
			fmt.Fprintln(os.Stderr, "Error:", err)
			return err
		}

		fmt.Printf("Unmounted %s\n", absTarget)
		return nil
	},
}

// validateScriptCmdFlags checks that exactly one of script/cmd is set and that
// trailing args are only used with --script.
func validateScriptCmdFlags(script, cmdStr string, trailingArgs []string) error {
	hasScript := script != ""
	hasCmd := cmdStr != ""
	if !hasScript && !hasCmd {
		return fmt.Errorf("exactly one of --script or --cmd must be specified")
	}
	if hasScript && hasCmd {
		return fmt.Errorf("--script and --cmd are mutually exclusive")
	}
	if hasCmd && len(trailingArgs) > 0 {
		return fmt.Errorf("trailing arguments are not allowed with --cmd")
	}
	return nil
}

var materializeCmd = &cobra.Command{
	Use:   "materialize [-- script-args...]",
	Short: "Run a script or command and copy output files to a destination",
	Long: `Run a script or command and copy output files to a destination directory.

This simulates a sandboxed execution model where the script/command runs in
isolation and its outputs are "materialized" to the host.

Exactly one of --script or --cmd must be specified.

With --script, any arguments after -- are forwarded to the script:
  clawbox v0 materialize --script ./foo.sh --workdir w --outdir o --destdir d -- arg1 arg2

With --cmd, a bash command string is executed directly:
  clawbox v0 materialize --cmd "python3 helper.py --seed 42" --workdir w --outdir o --destdir d`,
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		script, _ := cmd.Flags().GetString("script")
		cmdStr, _ := cmd.Flags().GetString("cmd")
		workdir, _ := cmd.Flags().GetString("workdir")
		outdir, _ := cmd.Flags().GetString("outdir")
		destdir, _ := cmd.Flags().GetString("destdir")

		if err := validateScriptCmdFlags(script, cmdStr, args); err != nil {
			return err
		}
		hasScript := script != ""

		// Convert to absolute paths
		absWorkdir, err := filepath.Abs(workdir)
		if err != nil {
			return fmt.Errorf("failed to resolve workdir path: %w", err)
		}
		absOutdir, err := filepath.Abs(outdir)
		if err != nil {
			return fmt.Errorf("failed to resolve outdir path: %w", err)
		}
		absDestdir, err := filepath.Abs(destdir)
		if err != nil {
			return fmt.Errorf("failed to resolve destdir path: %w", err)
		}

		opts := materialize.Options{
			Cmd:     cmdStr,
			Workdir: absWorkdir,
			Outdir:  absOutdir,
			Destdir: absDestdir,
		}

		if hasScript {
			absScript, err := filepath.Abs(script)
			if err != nil {
				return fmt.Errorf("failed to resolve script path: %w", err)
			}
			opts.Script = absScript
			opts.ScriptArgs = args
		}

		if err := materialize.Run(opts); err != nil {
			return err
		}

		fmt.Printf("Materialized output from %s to %s\n", absOutdir, absDestdir)
		return nil
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
	materializeCmd.Flags().String("script", "", "Path to the script to execute (mutually exclusive with --cmd)")
	materializeCmd.Flags().String("cmd", "", "Bash command string to execute (mutually exclusive with --script)")
	materializeCmd.Flags().String("workdir", "", "Working directory for script execution (required)")
	materializeCmd.Flags().String("outdir", "", "Directory where the script writes output files (required)")
	materializeCmd.Flags().String("destdir", "", "Host directory where output files are copied (required)")
	materializeCmd.MarkFlagRequired("workdir")
	materializeCmd.MarkFlagRequired("outdir")
	materializeCmd.MarkFlagRequired("destdir")
}
