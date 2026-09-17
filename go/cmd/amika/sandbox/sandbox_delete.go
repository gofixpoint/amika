package sandboxcmd

// sandbox_delete.go implements rig deletion against the remote Amika API.

import (
	"bufio"
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/cliprompt"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var sandboxDeleteCmd = &cobra.Command{
	Use:     "delete <name> [<name>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more sandboxes",
	Long:    `Delete one or more sandboxes.`,
	Args:    cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
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
				fmt.Sprintf("Delete sandbox(es) %s?", strings.Join(args, ", ")),
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
		for _, name := range args {
			if remoteErr := remoteClient.DeleteSandbox(name); remoteErr != nil {
				errs = append(errs, fmt.Sprintf("sandbox %q: %v", name, remoteErr))
				results = append(results, batchError(name, remoteErr))
				continue
			}
			fmt.Fprintf(pw, "Sandbox %q deleted\n", name)
			results = append(results, output.ItemResult{Name: name, Status: "deleted"})
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
