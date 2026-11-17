package main

// cloud_account.go implements the `amika cloud-account` command group over
// the cloud accounts API (/cloud-accounts). A cloud account is an
// organization's own account at a sandbox provider (bring your own cloud);
// `amika rig create --cloud-account` runs a rig in one.
//
// The account's API key goes up on create and update and never comes back,
// and the CLI never takes it as a plain flag value, which would land in shell
// history and in the process list. It comes from a file, stdin, or a named
// environment variable instead.

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/auth"
	"github.com/gofixpoint/amika/go/internal/cliprompt"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var cloudAccountCmd = &cobra.Command{
	Use:     "cloud-account",
	Aliases: []string{"cloud-accounts"},
	Short:   "Manage your organization's own cloud provider accounts (beta)",
	Long: `Manage your organization's own accounts at sandbox providers (beta).

By default a cloud rig runs in a provider account that Amika owns and pays for.
Connect your organization's own account at a provider, such as InstaBox, and
` + "`amika rig create --cloud-account <account>`" + ` runs the rig there, on your
provider quota and bill. Amika stores the account's API key and never returns
it.

Each provider can have one default account. A rig create that names the
provider and no account lands in it, or on Amika Cloud when there is none.
The account name "amika" always means Amika Cloud.

An <account> is the account's name or id, or name=<name> / id=<id> to match
one field. Names are unique per provider, so --provider narrows a name that
two providers share.

Where cloud accounts are not enabled, these commands fail with HTTP 404.`,
}

var cloudAccountCreateCmd = &cobra.Command{
	Use:   "create --provider <provider> --name <name> --api-key-file <path> [flags]",
	Short: "Connect a cloud provider account",
	Long: `Connect your organization's account at a sandbox provider.

The provider API key comes from --api-key-file (- reads stdin) or from the
environment variable --api-key-env names, never from a plain flag value. Amika
does not test the key when you connect it.

A provider can have one account for now. With --default, rigs that name the
provider and no account land in this one.`,
	Example: `  amika cloud-account create --provider instabox --name prod --api-key-file ./instabox-key --default
  vault kv get -field=key secret/instabox | amika cloud-account create --provider instabox --name prod --api-key-file -
  amika cloud-account create --provider instabox --name prod --api-key-env INSTABOX_API_KEY`,
	Args: cobra.NoArgs,
	RunE: runCloudAccountCreate,
}

// cloudAccountCreateUsageTemplate shows both ways `cloud-account create`
// reads the API key.
const cloudAccountCreateUsageTemplate = `Usage:
  {{.CommandPath}} --provider <provider> --name <name> --api-key-file <path> [flags]
  {{.CommandPath}} --provider <provider> --name <name> --api-key-env <var> [flags]{{if .HasExample}}

Examples:
{{.Example}}{{end}}{{if .HasAvailableLocalFlags}}

Flags:
{{.LocalFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}{{if .HasAvailableInheritedFlags}}

Global Flags:
{{.InheritedFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}
`

var cloudAccountListCmd = &cobra.Command{
	Use:     "list [flags]",
	Aliases: []string{"ls"},
	Short:   "List your organization's cloud provider accounts",
	Args:    cobra.NoArgs,
	RunE:    runCloudAccountList,
}

var cloudAccountGetCmd = &cobra.Command{
	Use:   "get <account> [flags]",
	Short: "Show one cloud provider account",
	Args:  cobra.ExactArgs(1),
	RunE:  runCloudAccountGet,
}

var cloudAccountUpdateCmd = &cobra.Command{
	Use:   "update <account> [flags]",
	Short: "Rename a cloud provider account or replace its API key",
	Long: `Rename a cloud provider account or replace its API key. Only the given
flags change.

A new key comes from --api-key-file (- reads stdin) or --api-key-env. Each rig
in the account uses it from its next operation; running rigs keep running.`,
	Args: cobra.ExactArgs(1),
	RunE: runCloudAccountUpdate,
}

var cloudAccountSetDefaultCmd = &cobra.Command{
	Use:   "set-default <account> [flags]",
	Short: "Make an account its provider's default for new rigs",
	Long: `Make an account its provider's default: a rig create that names the provider
and no account lands in it. It replaces the provider's previous default.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCloudAccountSetDefault(cmd, args[0], true)
	},
}

var cloudAccountUnsetDefaultCmd = &cobra.Command{
	Use:   "unset-default <account> [flags]",
	Short: "Stop an account being its provider's default",
	Long: `Stop an account being its provider's default. A rig create that names the
provider and no account then lands on Amika Cloud.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runCloudAccountSetDefault(cmd, args[0], false)
	},
}

var cloudAccountDeleteCmd = &cobra.Command{
	Use:     "delete <account> [<account>...] [flags]",
	Aliases: []string{"rm", "remove"},
	Short:   "Disconnect one or more cloud provider accounts",
	Long: `Disconnect one or more cloud provider accounts and delete their stored API
keys. The account itself, at the provider, is untouched.

An account that still has rigs or snapshots in it is refused; delete those
first. To find them, filter ` + "`amika rig list -o json`" + ` on cloud_account.`,
	Args: cobra.MinimumNArgs(1),
	RunE: runCloudAccountDelete,
}

func runCloudAccountCreate(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	flags := cmd.Flags()
	provider, _ := flags.GetString("provider")
	name, _ := flags.GetString("name")
	switch {
	case strings.TrimSpace(provider) == "":
		return fmt.Errorf("--provider is required, e.g. --provider instabox")
	case strings.TrimSpace(name) == "":
		return fmt.Errorf("--name is required")
	}
	key, err := readCloudAccountKey(cmd)
	if err != nil {
		return err
	}
	if key == "" {
		return fmt.Errorf("pass the provider API key with --api-key-file <path> (- for stdin) or --api-key-env <var>")
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	req := apiclient.CreateCloudAccountRequest{Provider: provider, Name: name, APIKey: key}
	if isDefault, _ := flags.GetBool("default"); isDefault {
		req.IsDefault = &isDefault
	}
	account, err := runmode.NewRemoteClient().CreateCloudAccount(req)
	if err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), account)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Cloud account %q connected\n\n", account.Name)
	return writeCloudAccount(cmd.OutOrStdout(), account)
}

func runCloudAccountList(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	provider, _ := cmd.Flags().GetString("provider")
	list, err := runmode.NewRemoteClient().ListCloudAccounts(provider)
	if err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), list)
	}
	if len(list.Items) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No cloud accounts found. Rigs run on Amika Cloud.")
		return nil
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "PROVIDER\tNAME\tDEFAULT\tID\tCREATED")
	for _, a := range list.Items {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", tableCell(a.Provider), tableCell(a.Name), yesNo(a.IsDefault), a.ID, a.CreatedAt)
	}
	return w.Flush()
}

func runCloudAccountGet(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseCloudAccountRef(cmd, args[0])
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	account, err := runmode.NewRemoteClient().GetCloudAccount(sel)
	if err != nil {
		return explainCloudAccountRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), account)
	}
	return writeCloudAccount(cmd.OutOrStdout(), account)
}

func runCloudAccountUpdate(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseCloudAccountRef(cmd, args[0])
	if err != nil {
		return err
	}
	var req apiclient.UpdateCloudAccountRequest
	if cmd.Flags().Changed("name") {
		name, _ := cmd.Flags().GetString("name")
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("--name must not be empty")
		}
		req.Name = &name
	}
	key, err := readCloudAccountKey(cmd)
	if err != nil {
		return err
	}
	if key != "" {
		req.APIKey = &key
	}
	if req.Name == nil && req.APIKey == nil {
		return fmt.Errorf("nothing to change; pass --name, --api-key-file, or --api-key-env")
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	account, err := runmode.NewRemoteClient().UpdateCloudAccount(sel, req)
	if err != nil {
		return explainCloudAccountRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), account)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Cloud account %q updated\n\n", account.Name)
	return writeCloudAccount(cmd.OutOrStdout(), account)
}

func runCloudAccountSetDefault(cmd *cobra.Command, raw string, isDefault bool) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseCloudAccountRef(cmd, raw)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	account, err := runmode.NewRemoteClient().UpdateCloudAccount(sel, apiclient.UpdateCloudAccountRequest{IsDefault: &isDefault})
	if err != nil {
		return explainCloudAccountRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), account)
	}
	if isDefault {
		fmt.Fprintf(cmd.OutOrStdout(), "Cloud account %q is now the default for %s rigs\n", account.Name, account.Provider)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Cloud account %q is no longer the default; %s rigs that name no account run on Amika Cloud\n", account.Name, account.Provider)
	}
	return nil
}

func runCloudAccountDelete(cmd *cobra.Command, args []string) error {
	force, _ := cmd.Flags().GetBool("force")
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sels := make([]apiclient.CloudAccountSelector, len(args))
	for i, raw := range args {
		if sels[i], err = parseCloudAccountRef(cmd, raw); err != nil {
			return err
		}
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	if !force && format.IsJSON() {
		return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete", output.FlagName, format)
	}
	if !force {
		confirmed, err := cliprompt.Confirm(
			fmt.Sprintf("Disconnect cloud account(s) %s and delete their stored API keys?", strings.Join(args, ", ")),
			bufio.NewReader(cmd.InOrStdin()),
		)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
			return nil
		}
	}

	client := runmode.NewRemoteClient()
	pw := format.Progress(cmd.OutOrStdout())
	var errs []string
	results := []output.ItemResult{}
	for i, sel := range sels {
		ref := args[i]
		if err := explainCloudAccountRef(sel, client.DeleteCloudAccount(sel)); err != nil {
			errs = append(errs, fmt.Sprintf("cloud account %q: %v", ref, err))
			results = append(results, output.ItemResult{Name: ref, Status: "error", Error: err.Error()})
			continue
		}
		fmt.Fprintf(pw, "Cloud account %q deleted\n", ref)
		results = append(results, output.ItemResult{Name: ref, Status: "deleted"})
	}

	if format.IsJSON() {
		if err := format.JSON(cmd.OutOrStdout(), results); err != nil {
			return err
		}
		if len(errs) > 0 {
			return fmt.Errorf("%d of %d failed; see JSON output", len(errs), len(results))
		}
		return nil
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "\n"))
	}
	return nil
}

// parseCloudAccountRef parses an account reference, a name or id, or
// name=<name> / id=<id> / ref=<value> to say which field it matches, and
// narrows it to the command's --provider.
func parseCloudAccountRef(cmd *cobra.Command, raw string) (apiclient.CloudAccountSelector, error) {
	sel, err := parseCloudAccountSelector(raw)
	if err != nil {
		return apiclient.CloudAccountSelector{}, err
	}
	sel.Provider, _ = cmd.Flags().GetString("provider")
	return sel, nil
}

// parseCloudAccountSelector parses an account reference with no provider:
// a name or id, or name=<name> / id=<id> / ref=<value>.
func parseCloudAccountSelector(raw string) (apiclient.CloudAccountSelector, error) {
	sel := apiclient.CloudAccountSelector{Value: raw, By: apiclient.SelectByRef}
	if kind, ok := rigref.Prefix(raw); ok {
		sel = apiclient.CloudAccountSelector{Value: raw[len(kind)+1:], By: string(kind)}
	}
	if strings.TrimSpace(sel.Value) == "" {
		return apiclient.CloudAccountSelector{}, fmt.Errorf("cloud account reference %q is empty", raw)
	}
	return sel, nil
}

// explainCloudAccountRef rewrites the API's 409 resource_ref_ambiguous into
// an error that says how to pick one account. A name can match an account on
// each of two providers, and a plain ref can also match one account's id and
// another's name.
func explainCloudAccountRef(sel apiclient.CloudAccountSelector, err error) error {
	if err == nil || !apiclient.IsResourceRefAmbiguous(err) {
		return err
	}
	switch {
	case sel.By == apiclient.SelectByRef && sel.Provider == "":
		return fmt.Errorf("%q matches more than one cloud account; pass --provider, or use %q or %q", sel.Value, "id="+sel.Value, "name="+sel.Value)
	case sel.By == apiclient.SelectByRef:
		return fmt.Errorf("%q is one cloud account's id and another's name; use %q or %q", sel.Value, "id="+sel.Value, "name="+sel.Value)
	case sel.By == apiclient.SelectByName && sel.Provider == "":
		return fmt.Errorf("more than one provider has a cloud account named %q; pass --provider", sel.Value)
	}
	return err
}

// readCloudAccountKey reads the provider API key from --api-key-file (a path,
// or - for stdin) or --api-key-env (a variable name), trimmed. It returns ""
// when neither flag was given. The key never appears in an error.
func readCloudAccountKey(cmd *cobra.Command) (string, error) {
	flags := cmd.Flags()
	fromFile, fromEnv := flags.Changed("api-key-file"), flags.Changed("api-key-env")
	switch {
	case fromFile && fromEnv:
		return "", fmt.Errorf("--api-key-file and --api-key-env cannot be combined")
	case fromFile:
		path, _ := flags.GetString("api-key-file")
		return readCloudAccountKeyFile(cmd, path)
	case fromEnv:
		name, _ := flags.GetString("api-key-env")
		if strings.TrimSpace(name) == "" {
			return "", fmt.Errorf("--api-key-env needs the name of an environment variable")
		}
		value, ok := os.LookupEnv(name)
		if !ok {
			return "", fmt.Errorf("--api-key-env: environment variable %s is not set", name)
		}
		key, err := auth.ReadAPIKeyFromReader(strings.NewReader(value))
		if err != nil {
			return "", fmt.Errorf("--api-key-env %s: %w", name, err)
		}
		return key, nil
	}
	return "", nil
}

// readCloudAccountKeyFile reads a key from path, or from stdin for "-".
func readCloudAccountKeyFile(cmd *cobra.Command, path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("--api-key-file needs a path, or - for stdin")
	}
	var src io.Reader = cmd.InOrStdin()
	if path != "-" {
		f, err := os.Open(path)
		if err != nil {
			return "", fmt.Errorf("opening API key file: %w", err)
		}
		defer f.Close()
		src = f
	}
	key, err := auth.ReadAPIKeyFromReader(src)
	if err != nil {
		return "", fmt.Errorf("--api-key-file %s: %w", path, err)
	}
	return key, nil
}

func writeCloudAccount(out io.Writer, a *apiclient.CloudAccount) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "Name:\t%s\n", tableCell(a.Name))
	fmt.Fprintf(w, "ID:\t%s\n", a.ID)
	fmt.Fprintf(w, "Provider:\t%s\n", tableCell(a.Provider))
	fmt.Fprintf(w, "Default:\t%s\n", yesNo(a.IsDefault))
	fmt.Fprintf(w, "Created:\t%s\n", a.CreatedAt)
	fmt.Fprintf(w, "Updated:\t%s\n", a.UpdatedAt)
	return w.Flush()
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

func init() {
	rootCmd.AddCommand(cloudAccountCmd)
	cloudAccountCmd.AddCommand(cloudAccountCreateCmd, cloudAccountListCmd, cloudAccountGetCmd, cloudAccountUpdateCmd,
		cloudAccountSetDefaultCmd, cloudAccountUnsetDefaultCmd, cloudAccountDeleteCmd)

	cloudAccountCreateCmd.SetUsageTemplate(cloudAccountCreateUsageTemplate)

	const providerHelp = "Match <account> among this provider's accounts only (names are unique per provider)"
	keyFlags := func(c *cobra.Command) {
		c.Flags().String("api-key-file", "", "Read the provider API key from this file (- for stdin)")
		c.Flags().String("api-key-env", "", "Read the provider API key from this environment variable")
	}

	c := cloudAccountCreateCmd.Flags()
	c.String("provider", "", "Sandbox provider of the account, e.g. instabox")
	c.String("name", "", "Name of the account: lowercase letters, digits, and -; not \"amika\"")
	c.Bool("default", false, "Make it the provider's default account for new rigs")
	keyFlags(cloudAccountCreateCmd)

	cloudAccountListCmd.Flags().String("provider", "", "List only this provider's accounts")

	for _, sub := range []*cobra.Command{cloudAccountGetCmd, cloudAccountUpdateCmd, cloudAccountSetDefaultCmd, cloudAccountUnsetDefaultCmd, cloudAccountDeleteCmd} {
		sub.Flags().String("provider", "", providerHelp)
	}
	cloudAccountUpdateCmd.Flags().String("name", "", "New name")
	keyFlags(cloudAccountUpdateCmd)

	cloudAccountDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
}
