package sandboxcmd

// sandbox_create_snapshot.go turns the create command's --snapshot,
// --no-snapshot, and --preset flags into the request's snapshot selection.

import (
	"fmt"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/spf13/cobra"
)

// validateCreateSnapshotFlags rejects the snapshot flag combinations that
// cannot be honored. It needs no network, so RunE calls it before the auth
// gate.
//
// Keyed on values rather than Changed, like the --snapshot check in
// createHostRef: an empty --snapshot or --preset is dropped from the request
// body, so it asks for nothing that could conflict.
func validateCreateSnapshotFlags(cmd *cobra.Command) error {
	snapshot, _ := cmd.Flags().GetString("snapshot")
	if snapshot == "" {
		return nil
	}
	if noSnapshot, _ := cmd.Flags().GetBool("no-snapshot"); noSnapshot {
		return fmt.Errorf("--snapshot and --no-snapshot are mutually exclusive")
	}
	if preset, _ := cmd.Flags().GetString("preset"); preset != "" {
		return fmt.Errorf("--preset cannot be combined with --snapshot: a captured snapshot carries its own preset, so drop --preset to boot it")
	}
	return nil
}

// createSnapshotSelection reads the snapshot flags into the request's
// snapshot field. validateCreateSnapshotFlags has already refused the
// conflicting combinations.
//
// --preset sends null itself rather than leaving it to the server: a server
// that predates treating a bare preset as null would otherwise fork the
// repository's default snapshot and ignore the preset that was asked for.
func createSnapshotSelection(cmd *cobra.Command) apiclient.SnapshotSelection {
	if snapshot, _ := cmd.Flags().GetString("snapshot"); snapshot != "" {
		return apiclient.SnapshotSlug(snapshot)
	}
	noSnapshot, _ := cmd.Flags().GetBool("no-snapshot")
	preset, _ := cmd.Flags().GetString("preset")
	if noSnapshot || preset != "" {
		return apiclient.NoSnapshot()
	}
	return apiclient.SnapshotSelection{}
}
