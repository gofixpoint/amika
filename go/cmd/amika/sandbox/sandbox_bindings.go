package sandboxcmd

import (
	"bufio"
	"fmt"
	"net/url"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
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
  {{.CommandPath}} <rig> <target> [flags]{{if gt (len .Aliases) 0}}

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
	rawRig, _ := cmd.Flags().GetString("rig")
	if rawRig == "" && cmd.Flags().Changed("rig-by") {
		return fmt.Errorf("--rig-by requires --rig")
	}
	var ref rigref.Ref
	if rawRig != "" {
		parsed, err := parseRigRefWithBy(cmd, rawRig)
		if err != nil {
			return err
		}
		ref = parsed
	}

	target, err := getRemoteTarget(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
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
	if rawRig == "" {
		result, err = client.ListSandboxBindings()
	} else {
		result, err = client.ListSandboxBindingsForSandbox(ref.Selector())
	}
	if err != nil {
		return rigref.Explain(ref, err)
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
	if len(args) == 1 && cmd.Flags().Changed("rig-by") {
		return fmt.Errorf("--rig-by requires the <rig> <target> form")
	}
	var ref rigref.Ref
	if len(args) == 2 {
		rawRig := strings.TrimSpace(args[0])
		if rawRig == "" {
			return fmt.Errorf("a rig reference is required")
		}
		parsed, err := parseRigRefWithBy(cmd, rawRig)
		if err != nil {
			return err
		}
		ref = parsed
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
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	client, err := getRemoteClient(target)
	if err != nil {
		return err
	}

	bindingID := strings.TrimSpace(args[0])
	description := fmt.Sprintf("binding %q", bindingID)
	if len(args) == 2 {
		bindingTarget := args[1]
		bindings, err := client.ListSandboxBindingsForSandbox(ref.Selector())
		if err != nil {
			return rigref.Explain(ref, err)
		}
		binding, err := findSandboxBindingByTarget(bindings.Items, bindingTarget)
		if err != nil {
			return err
		}
		bindingID = binding.ID
		description = fmt.Sprintf("binding %q for target %q on sandbox %q", bindingID, bindingTarget, rigref.Label(strings.TrimSpace(args[0]), ref))
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
	switch rigref.Kind(kind) {
	case rigref.KindRef, rigref.KindName, rigref.KindID:
		return nil
	default:
		return fmt.Errorf("invalid --rig-by value %q: must be one of ref, name, id", kind)
	}
}

// parseRigRefWithBy parses raw, a rig reference given to a command that still
// accepts the hidden --rig-by, the flag-based spelling of a reference's kind
// that `name=`/`id=` prefixes replaced.
//
// A prefix in raw wins over the --rig-by default. A --rig-by value that pins
// a field ("name" or "id") applies to an unprefixed raw as if it were that
// prefix, and refuses a prefix that names a different kind rather than guess
// which of the two the caller meant.
func parseRigRefWithBy(cmd *cobra.Command, raw string) (rigref.Ref, error) {
	rigBy, _ := cmd.Flags().GetString("rig-by")
	if err := validateSandboxBindingRefKind(rigBy); err != nil {
		return rigref.Ref{}, err
	}
	by := rigref.Kind(rigBy)
	prefix, prefixed := rigref.Prefix(raw)
	switch {
	case by == rigref.KindRef:
		return rigref.Parse(raw)
	case prefixed && prefix != by:
		return rigref.Ref{}, fmt.Errorf("--rig-by %s conflicts with the %s= prefix in %q; drop --rig-by", by, prefix, raw)
	case prefixed:
		return rigref.Parse(raw)
	default:
		return rigref.Parse(string(by) + "=" + raw)
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
