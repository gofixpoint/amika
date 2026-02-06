package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/wisp/internal/materialize"
	"github.com/spf13/cobra"
)

const sandboxWorkdir = "/home/wisp/workspace"

// resolveSandboxOutdir resolves the outdir flag relative to the sandbox.
//   - Empty → returns workdir (default: script CWD)
//   - Absolute → relative to sandbox root (e.g. /output → sandboxRoot/output)
//   - Relative → relative to workdir (e.g. out → workdir/out)
func resolveSandboxOutdir(outdir, sandboxRoot, workdir string) string {
	if outdir == "" {
		return workdir
	}
	if filepath.IsAbs(outdir) {
		return filepath.Join(sandboxRoot, strings.TrimPrefix(outdir, "/"))
	}
	return filepath.Join(workdir, outdir)
}

var topMaterializeCmd = &cobra.Command{
	Use:   "materialize [-- script-args...]",
	Short: "Run a script or command in a temp sandbox and copy outputs to a destination",
	Long: `Run a script or command in an auto-created temporary sandbox and copy output
files to a destination directory.

The sandbox mimics a filesystem root with an implicit working directory at
/home/wisp/workspace. The script/command runs with CWD set to this workdir.

Exactly one of --script or --cmd must be specified.

The --outdir flag controls which sandbox directory gets copied to --destdir:
  (default)    The workdir itself (script CWD)
  Absolute     Resolved relative to sandbox root (e.g. /output)
  Relative     Resolved relative to workdir (e.g. out)

The WISP_SANDBOX_ROOT environment variable is set for the child process,
pointing to the sandbox root directory.

Examples:
  wisp materialize --cmd "echo hi > result.txt" --destdir /tmp/dest
  wisp materialize --script ./gen.sh --destdir /tmp/dest -- arg1 arg2
  wisp materialize --cmd "echo hi > $WISP_SANDBOX_ROOT/output/r.txt" --outdir /output --destdir /tmp/dest`,
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		script, _ := cmd.Flags().GetString("script")
		cmdStr, _ := cmd.Flags().GetString("cmd")
		outdir, _ := cmd.Flags().GetString("outdir")
		destdir, _ := cmd.Flags().GetString("destdir")

		if err := validateScriptCmdFlags(script, cmdStr, args); err != nil {
			return err
		}

		// Create sandbox root
		sandboxRoot, err := os.MkdirTemp("", "wisp-sandbox-*")
		if err != nil {
			return fmt.Errorf("failed to create sandbox: %w", err)
		}
		defer os.RemoveAll(sandboxRoot)

		// Create workdir inside sandbox
		workdir := filepath.Join(sandboxRoot, sandboxWorkdir[1:]) // trim leading /
		if err := os.MkdirAll(workdir, 0755); err != nil {
			return fmt.Errorf("failed to create sandbox workdir: %w", err)
		}

		// Resolve outdir and destdir
		absOutdir := resolveSandboxOutdir(outdir, sandboxRoot, workdir)
		absDestdir, err := filepath.Abs(destdir)
		if err != nil {
			return fmt.Errorf("failed to resolve destdir path: %w", err)
		}

		opts := materialize.Options{
			Cmd:     cmdStr,
			Workdir: workdir,
			Outdir:  absOutdir,
			Destdir: absDestdir,
			Env:     []string{"WISP_SANDBOX_ROOT=" + sandboxRoot},
		}

		if script != "" {
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
	rootCmd.AddCommand(topMaterializeCmd)

	topMaterializeCmd.Flags().String("script", "", "Path to the script to execute (mutually exclusive with --cmd)")
	topMaterializeCmd.Flags().String("cmd", "", "Bash command string to execute (mutually exclusive with --script)")
	topMaterializeCmd.Flags().String("outdir", "", "Sandbox directory to copy from (default: workdir)")
	topMaterializeCmd.Flags().String("destdir", "", "Host directory where output files are copied (required)")
	topMaterializeCmd.MarkFlagRequired("destdir")
}
