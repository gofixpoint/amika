package sandboxcmd

// sandbox_delete.go implements rig deletion against the remote Amika API.

import (
	"bufio"
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/cliprompt"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var sandboxDeleteCmd = &cobra.Command{
	Use:     "delete <rig> [<rig>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more sandboxes",
	Long:    `Delete one or more sandboxes, each named by name or ID (see "amika rig --help").`,
	Args:    cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		refs, err := rigref.ParseAll(args)
		if err != nil {
			return err
		}
		labels := make([]string, len(args))
		for i, raw := range args {
			labels[i] = rigref.Label(raw, refs[i])
		}
		force, _ := cmd.Flags().GetBool("force")

		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}

		if !force {
			if format.IsJSON() {
				return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete", output.FlagName, format)
			}
			reader := bufio.NewReader(cmd.InOrStdin())
			confirmed, err := cliprompt.Confirm(
				fmt.Sprintf("Delete sandbox(es) %s?", strings.Join(labels, ", ")),
				reader,
			)
			if err != nil {
				return err
			}
			if !confirmed {
				fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
				return nil
			}
		}

		pw := format.Progress(cmd.OutOrStdout())

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
			return err
		}

		remoteClient, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		var errs []string
		var results []output.ItemResult
		// The API answers a delete with no body, so the rig is reported the
		// way the user named it.
		for i, ref := range refs {
			label := labels[i]
			if remoteErr := rigref.Explain(ref, remoteClient.DeleteSandbox(ref.Selector())); remoteErr != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q: %v", label, remoteErr))
				results = append(results, batchError(label, remoteErr))
				continue
			}
			fmt.Fprintf(pw, "Sandbox %q deleted\n", label)
			results = append(results, output.ItemResult{Name: label, Status: "deleted"})
		}

		if format.IsJSON() {
			if results == nil {
				results = []output.ItemResult{}
			}
			if err := format.JSON(cmd.OutOrStdout(), results); err != nil {
				return err
			}
			if len(errs) > 0 {
				return fmt.Errorf("deletion completed with errors; see JSON output")
			}
			return nil
		}
		if len(errs) > 0 {
			return fmt.Errorf("%s", strings.Join(errs, "\n"))
		}
		return nil
	},
}
