package main

import (
	"fmt"
	"os"
	"os/exec"

	policy "github.com/gofixpoint/amika/go/labs/amikalyze"
	"github.com/spf13/cobra"
)

var runCmd = &cobra.Command{
	Use:   "run [flags] -- <agent> [args...]",
	Short: "Run an agent with process-scoped freeze overrides",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("resolving working directory: %w", err)
		}
		repoRoot, err := policy.RepositoryRoot(cwd)
		if err != nil {
			return fmt.Errorf("amikalyze run requires a Git worktree: %w", err)
		}
		labels, err := cmd.Flags().GetStringArray("unfreeze")
		if err != nil {
			return err
		}
		paths, err := cmd.Flags().GetStringArray("unfreeze-path")
		if err != nil {
			return err
		}
		overrides, err := policy.NewOverrides(repoRoot, labels, paths)
		if err != nil {
			return err
		}
		assignment, err := policy.OverridesEnvironment(overrides)
		if err != nil {
			return err
		}

		child := exec.Command(args[0], args[1:]...)
		child.Stdin = cmd.InOrStdin()
		child.Stdout = cmd.OutOrStdout()
		child.Stderr = cmd.ErrOrStderr()
		child.Env = policy.ReplaceOverridesEnvironment(os.Environ(), assignment)
		return child.Run()
	},
}

func init() {
	rootCmd.AddCommand(runCmd)
	runCmd.Flags().StringArray("unfreeze", nil, "Temporarily unfreeze a label; repeat for multiple labels")
	runCmd.Flags().StringArray("unfreeze-path", nil, "Temporarily unfreeze one exact repo-relative path; repeat as needed")
}
