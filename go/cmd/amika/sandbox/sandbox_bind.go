package sandboxcmd

import (
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var sandboxBindCmd = &cobra.Command{
	Use:    "bind <rig> gh-branch:<owner>/<repo>/<branch>",
	Short:  "Bind a remote sandbox to a resource",
	Hidden: true,
	Args:   cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		ref, err := parseRigRefWithBy(cmd, args[0])
		if err != nil {
			return err
		}
		owner, repo, branch, err := parseGitHubBranchBinding(args[1])
		if err != nil {
			return err
		}
		if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
			return err
		}
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		format, err := output.FormatFrom(cmd)
		if err != nil {
			return err
		}
		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		rebind, _ := cmd.Flags().GetBool("rebind")

		binding, err := client.BindSandboxGitHubBranch(ref.Selector(), owner, repo, branch, rebind)
		if err != nil {
			return rigref.Explain(ref, err)
		}
		if format.IsJSON() {
			return format.JSON(cmd.OutOrStdout(), binding)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Bound rig %q to %s/%s branch %q (%s).\n", rigref.Label(args[0], ref), owner, repo, branch, binding.ID)
		return nil
	},
}

func parseGitHubBranchBinding(raw string) (string, string, string, error) {
	const prefix = "gh-branch:"
	if !strings.HasPrefix(raw, prefix) {
		return "", "", "", fmt.Errorf("unsupported binding target %q: expected gh-branch:<owner>/<repo>/<branch>", raw)
	}

	parts := strings.SplitN(strings.TrimPrefix(raw, prefix), "/", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", "", fmt.Errorf("invalid GitHub branch target %q: expected gh-branch:<owner>/<repo>/<branch>", raw)
	}
	return parts[0], parts[1], parts[2], nil
}
