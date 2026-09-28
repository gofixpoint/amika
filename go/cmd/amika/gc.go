package main

import (
	"fmt"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var gcCmd = &cobra.Command{
	Use:   "gc",
	Short: "Remove deleted sandboxes from the managed SSH config",
	Long: `Remove deleted sandboxes from ~/.ssh/amika.conf using the current account's
sandbox inventory. This runs immediately, regardless of entry count or the
time of the previous cleanup.

Entries belonging to other accounts or API endpoints, and older entries whose
ownership is unknown, are preserved. Use --prune-unknown to remove unknown
entries absent from the current account's inventory, including entries that
may belong to another account on the same API endpoint. Automatic cleanup also
runs when preparing an editor host if more than a day has passed or the entry
count exceeds both 50 and twice the number retained by the previous cleanup.`,
	Hidden: true,
	Args:   cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
			return err
		}
		pruneUnknown, err := cmd.Flags().GetBool("prune-unknown")
		if err != nil {
			return err
		}
		result, err := ssh.CollectGarbage(basedir.New(""), runmode.NewRemoteClient(), ssh.GCOptions{Force: true, PruneUnknown: pruneUnknown})
		if err != nil {
			return fmt.Errorf("garbage collect SSH config: %w", err)
		}
		if format.IsJSON() {
			return format.JSON(cmd.OutOrStdout(), result)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Removed %d SSH host entries; %d remain.\n", result.Removed, result.Remaining)
		if result.Unscoped > 0 {
			fmt.Fprintf(cmd.OutOrStdout(), "Preserved %d entries with unknown ownership.\n", result.Unscoped)
		}
		return nil
	},
}

func init() {
	gcCmd.Flags().Bool("prune-unknown", false, "Remove entries with unknown ownership absent from the current account's inventory")
	rootCmd.AddCommand(gcCmd)
}
