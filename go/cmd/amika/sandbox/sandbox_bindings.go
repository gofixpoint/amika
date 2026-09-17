package sandboxcmd

import (
	"bufio"
	"fmt"
	"net/url"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var sandboxBindingsCmd = &cobra.Command{
	Use:    "bindings",
	Short:  "Manage remote sandbox bindings",
	Hidden: true,
}

var sandboxBindingsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List sandbox bindings",
	Args:    cobra.NoArgs,
	RunE:    runSandboxBindingsList,
}

var sandboxBindingsDeleteCmd = &cobra.Command{
	Use:     "delete <binding-id>",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete a sandbox binding",
	Args:    cobra.RangeArgs(1, 2),
	RunE:    runSandboxBindingsDelete,
}

const sandboxBindingsDeleteUsageTemplate = `Usage:
  {{.CommandPath}} <binding-id> [flags]
  {{.CommandPath}} <rig-ref> <target> [flags]{{if gt (len .Aliases) 0}}

Aliases:
  {{.NameAndAliases}}{{end}}{{if .HasAvailableLocalFlags}}

Flags:
{{.LocalFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}{{if .HasAvailableInheritedFlags}}

Global Flags:
{{.InheritedFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}
`

func init() {
	sandboxBindingsCmd.AddCommand(sandboxBindingsListCmd)
	sandboxBindingsCmd.AddCommand(sandboxBindingsDeleteCmd)
	sandboxBindingsDeleteCmd.SetUsageTemplate(sandboxBindingsDeleteUsageTemplate)
}

func runSandboxBindingsList(cmd *cobra.Command, _ []string) error {
	if runmode.Resolve(cmd) != runmode.Remote {
		return fmt.Errorf("bindings list is only supported for remote sandboxes")
	}
	rigRef, _ := cmd.Flags().GetString("rig")
	rigBy, _ := cmd.Flags().GetString("rig-by")
	if rigRef == "" && cmd.Flags().Changed("rig-by") {
		return fmt.Errorf("--rig-by requires --rig")
	}
	if err := validateSandboxBindingRefKind(rigBy); err != nil {
		return err
	}

	target, err := getRemoteTarget(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
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

	var result *apiclient.ListSandboxBindingsResponse
	if rigRef == "" {
		result, err = client.ListSandboxBindings()
	} else {
		result, err = client.ListSandboxBindingsForSandbox(rigRef, rigBy)
	}
	if err != nil {
		return err
	}
	if result.Items == nil {
		result.Items = []apiclient.SandboxBinding{}
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), result)
	}
	if len(result.Items) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No bindings found.")
		return nil
	}

	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tSANDBOX ID\tTARGET\tRELATIONSHIP\tCREATED")
	for _, binding := range result.Items {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			binding.ID,
			binding.SandboxID,
			binding.TargetURL,
			binding.Relationship,
			binding.CreatedAt,
		)
	}
	return w.Flush()
}

func runSandboxBindingsDelete(cmd *cobra.Command, args []string) error {
	if runmode.Resolve(cmd) != runmode.Remote {
		return fmt.Errorf("bindings delete is only supported for remote sandboxes")
	}
	rigBy, _ := cmd.Flags().GetString("rig-by")
	if len(args) == 1 && cmd.Flags().Changed("rig-by") {
		return fmt.Errorf("--rig-by requires the <rig-ref> <target> form")
	}
	if err := validateSandboxBindingRefKind(rigBy); err != nil {
		return err
	}
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	force, _ := cmd.Flags().GetBool("force")
	if !force && format.IsJSON() {
		return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete", output.FlagName, format)
	}

	target, err := getRemoteTarget(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}
	client, err := getRemoteClient(target)
	if err != nil {
		return err
	}

	bindingID := strings.TrimSpace(args[0])
	description := fmt.Sprintf("binding %q", bindingID)
	if len(args) == 2 {
		sandboxRef := strings.TrimSpace(args[0])
		bindingTarget := args[1]
		if sandboxRef == "" {
			return fmt.Errorf("a sandbox reference is required")
		}
		bindings, err := client.ListSandboxBindingsForSandbox(sandboxRef, rigBy)
		if err != nil {
			return err
		}
		binding, err := findSandboxBindingByTarget(bindings.Items, bindingTarget)
		if err != nil {
			return err
		}
		bindingID = binding.ID
		description = fmt.Sprintf("binding %q for target %q on sandbox %q", bindingID, bindingTarget, sandboxRef)
	}
	if bindingID == "" {
		return fmt.Errorf("a binding ID is required")
	}

	if !force {
		confirmed, err := confirmSandboxBindingDelete(cmd, "Delete "+description+"?")
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
			return nil
		}
	}

	if err := client.DeleteSandboxBinding(bindingID); err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), output.ItemResult{Name: bindingID, Status: "deleted"})
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Binding %q deleted.\n", bindingID)
	return nil
}

func validateSandboxBindingRefKind(kind string) error {
	switch kind {
	case "ref", "name", "id":
		return nil
	default:
		return fmt.Errorf("invalid --rig-by value %q: must be one of ref, name, id", kind)
	}
}

func findSandboxBindingByTarget(bindings []apiclient.SandboxBinding, rawTarget string) (*apiclient.SandboxBinding, error) {
	wantOwner, wantRepo, wantBranch, err := parseGitHubBranchBinding(rawTarget)
	if err != nil {
		return nil, err
	}

	var matches []apiclient.SandboxBinding
	for _, binding := range bindings {
		if binding.TargetNamespace != "github" || binding.TargetKind != "branch" {
			continue
		}
		owner, repo, branch, err := parseGitHubBranchTargetURL(binding.TargetURL)
		if err != nil {
			continue
		}
		if strings.EqualFold(owner, wantOwner) && strings.EqualFold(repo, wantRepo) && branch == wantBranch {
			matches = append(matches, binding)
		}
	}

	switch len(matches) {
	case 1:
		return &matches[0], nil
	case 0:
		return nil, fmt.Errorf("no binding found for target %q; run bindings list to find its ID", rawTarget)
	default:
		return nil, fmt.Errorf("target %q matches multiple bindings; delete one by binding ID", rawTarget)
	}
}

func parseGitHubBranchTargetURL(raw string) (string, string, string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", "", "", err
	}
	if !strings.EqualFold(parsed.Hostname(), "github.com") {
		return "", "", "", fmt.Errorf("target is not a github.com URL")
	}
	parts := strings.SplitN(strings.Trim(parsed.Path, "/"), "/", 4)
	if len(parts) != 4 || parts[0] == "" || parts[1] == "" || parts[2] != "tree" || parts[3] == "" {
		return "", "", "", fmt.Errorf("target is not a GitHub branch URL")
	}
	return parts[0], parts[1], parts[3], nil
}

func confirmSandboxBindingDelete(cmd *cobra.Command, message string) (bool, error) {
	reader := bufio.NewReader(cmd.InOrStdin())
	for {
		fmt.Fprintf(cmd.OutOrStdout(), "%s [y/n] ", message)
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("failed to read confirmation: %w", err)
		}
		switch strings.ToLower(strings.TrimSpace(answer)) {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		default:
			fmt.Fprintln(cmd.OutOrStdout(), "Please enter 'y' or 'n'.")
		}
	}
}
