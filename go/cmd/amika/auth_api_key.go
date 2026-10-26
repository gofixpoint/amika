package main

// auth_api_key.go implements `amika auth api-key`, which manages Amika API
// keys through the control plane. Only `create` exists today; `list` and
// `delete` belong here when they are added.
//
// A key's plaintext value goes only to the file the caller names with --out,
// never to the CLI's own output, error messages, or the `-o json` result.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var authAPIKeyCmd = &cobra.Command{
	Use:   "api-key",
	Short: "Manage Amika API keys",
	Long: `Manage Amika API keys.

An API key authenticates a machine or a script without a browser login: the
amika CLI reads one from AMIKA_API_KEY or ` + "`amika auth login --api-key-file`" + `,
and amika-hostd reads one during setup.`,
}

var authAPIKeyCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an API key and write it to a file",
	Long: `Create an Amika API key and write it to a file.

The key's value is shown only once, so it goes straight into the file named
by --out and is never printed. The file is created with mode 0600 and holds
the bare key followed by a newline, so it can be passed to
` + "`amika auth login --api-key-file`" + ` or piped into
` + "`amika-hostd setup --non-interactive`" + ` as is. An existing file is refused
unless --force is given.

--scope picks who owns the key:

  organization  owned by your organization; it keeps working if you leave it
                (the default)
  user          owned by you; it acts as you, and an organization-scoped API
                key cannot create one

Requires a login (` + "`amika auth login`" + `) or AMIKA_API_KEY. Manage or delete
keys in the web app's settings page.`,
	Example: `  # Create a key owned by you for a host daemon, set the host up with it,
  # and remove the file
  dir=$(mktemp -d)
  amika auth api-key create --name build-01-hostd --scope user --out "$dir/api-key"
  amika-hostd setup --non-interactive --hostname build-01 < "$dir/api-key"
  rm -rf "$dir"

  # Create a key owned by you and log another machine's CLI in with it
  amika auth api-key create --name laptop --scope user --out ./amika-key
  amika auth login --api-key-file ./amika-key`,
	Args: cobra.NoArgs,
	RunE: runAuthAPIKeyCreate,
}

func runAuthAPIKeyCreate(cmd *cobra.Command, _ []string) error {
	name, _ := cmd.Flags().GetString("name")
	outPath, _ := cmd.Flags().GetString("out")
	scope, _ := cmd.Flags().GetString("scope")
	force, _ := cmd.Flags().GetBool("force")

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("--name must not be empty")
	}
	switch scope {
	case "", apiclient.APIKeyScopeOrganization, apiclient.APIKeyScopeUser:
	default:
		return fmt.Errorf("invalid --scope %q: must be %q or %q",
			scope, apiclient.APIKeyScopeOrganization, apiclient.APIKeyScopeUser)
	}

	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	dest, createdFile, err := openKeyFile(outPath, force)
	if err != nil {
		return err
	}
	defer dest.Close()
	// A failed create leaves no empty file behind, and a file that was
	// already there (with --force) keeps its contents until a key arrives.
	removeOnFail := func() {
		if createdFile {
			os.Remove(outPath)
		}
	}

	created, err := runmode.NewRemoteClient().CreateAPIKey(apiclient.CreateAPIKeyRequest{Name: name, Scope: scope})
	if err != nil {
		removeOnFail()
		var httpErr *apiclient.HTTPError
		if !errors.As(err, &httpErr) {
			// No HTTP status means the request may have reached the server
			// and the answer was lost (a timeout, a dropped connection), so
			// the key may exist without anyone holding its value.
			return fmt.Errorf("%w\nIf the request reached Amika, an API key named %q may now exist with its value lost; check %s",
				err, name, settingsURL())
		}
		return err
	}

	if err := writeKey(dest, created.Value.Reveal()); err != nil {
		return fmt.Errorf("created API key %q (%s) but could not write it to %s: %w\n"+
			"Its value cannot be shown again. Delete the key at %s and run this command again",
			created.Name, created.ID, outPath, err, settingsURL())
	}

	// -o json emits the API's ApiKeySummary schema: the create response
	// (ApiKeyWithValue) minus `value`. That is the API's own shape for a key
	// without its secret, the one a key listing returns, so a script reads
	// the same fields here as it will from `api-key list`. The file path is
	// left out; the caller passed it in --out.
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), created.APIKey)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Created API key %q (%s, scope %s, %s) and wrote it to %s\n",
		created.Name, created.ID, created.Scope, created.ObfuscatedValue, outPath)
	return nil
}

// settingsURL is the web app page where a person manages API keys.
func settingsURL() string {
	return strings.TrimRight(config.APIURL(), "/") + "/settings/api-keys"
}

// writeKey replaces what dest holds with key and a newline, then closes it,
// so a write the OS only reports at close still fails the command.
func writeKey(dest *os.File, key string) error {
	if info, err := dest.Stat(); err == nil && info.Mode().IsRegular() {
		if err := dest.Truncate(0); err != nil {
			return err
		}
	}
	if _, err := dest.WriteString(key + "\n"); err != nil {
		return err
	}
	return dest.Close()
}

// openKeyFile opens path for the key before the key is minted, so a path
// that cannot be written fails without leaving a key nobody can use. A new
// file is created with mode 0600; an existing one is refused unless force is
// set, and a replaced regular file is narrowed to 0600 too. Nothing is
// truncated here: writeKey empties the file only once a key has arrived.
// created reports whether this call made the file, so a failed run can
// remove it.
func openKeyFile(path string, force bool) (f *os.File, created bool, err error) {
	flags := os.O_WRONLY | os.O_CREATE
	if !force {
		flags |= os.O_EXCL
	}
	_, statErr := os.Stat(path)
	f, err = os.OpenFile(path, flags, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return nil, false, fmt.Errorf("%s already exists; pass --force to replace it", path)
	}
	if err != nil {
		return nil, false, fmt.Errorf("opening --out: %w", err)
	}
	if info, err := f.Stat(); err == nil && info.Mode().IsRegular() {
		if err := f.Chmod(0o600); err != nil {
			f.Close()
			return nil, false, fmt.Errorf("setting permissions on %s: %w", path, err)
		}
	}
	return f, errors.Is(statErr, fs.ErrNotExist), nil
}

func init() {
	authCmd.AddCommand(authAPIKeyCmd)
	authAPIKeyCmd.AddCommand(authAPIKeyCreateCmd)

	authAPIKeyCreateCmd.Flags().String("name", "", "Name for the key, shown in the web app's settings (required)")
	authAPIKeyCreateCmd.Flags().String("out", "", "File to write the key to, created with mode 0600 (required)")
	authAPIKeyCreateCmd.Flags().String("scope", "", `Who owns the key: "organization" (the default) or "user"`)
	authAPIKeyCreateCmd.Flags().BoolP("force", "f", false, "Replace --out if it already exists")
	_ = authAPIKeyCreateCmd.MarkFlagRequired("name")
	_ = authAPIKeyCreateCmd.MarkFlagRequired("out")
}
