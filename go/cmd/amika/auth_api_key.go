package main

// auth_api_key.go implements `amika auth api-key`, which manages Amika API
// keys through the control plane. Only `create` exists today; `list` and
// `delete` belong here when they are added.
//
// The one rule every subcommand here keeps: a key's plaintext value goes to a
// file the caller named, and nowhere else. Not stdout, not stderr, not an
// error message, and not the `-o json` result.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
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
unless --force is given; --out cannot be stdout.

--scope picks who owns the key:

  organization  owned by your organization; it keeps working if you leave it
                (the default)
  user          owned by you; it acts as you, and an organization-scoped API
                key cannot create one

Requires a login (` + "`amika auth login`" + `) or AMIKA_API_KEY. Manage or delete
keys in the web app's settings page.`,
	Example: `  # Create an organization key for a host daemon, set the host up with it,
  # and remove the file
  amika auth api-key create --name build-01-hostd --out ~/.amika-hostd-key
  amika-hostd setup --non-interactive --hostname build-01 < ~/.amika-hostd-key
  rm ~/.amika-hostd-key

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

	// Everything that can go wrong with the file is settled before the key
	// exists: the API shows its value once, so a key minted into a file that
	// then cannot be written is a key nobody can use.
	dest, err := prepareKeyFile(outPath, force)
	if err != nil {
		return err
	}
	defer dest.discard()

	created, err := runmode.NewRemoteClient().CreateAPIKey(apiclient.CreateAPIKeyRequest{Name: name, Scope: scope})
	if err != nil {
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

	if err := dest.commit(created.Value.Reveal()); err != nil {
		return fmt.Errorf("created API key %q (%s) but could not write it to %s: %w\n"+
			"Its value cannot be shown again. Delete the key at %s and run this command again",
			created.Name, created.ID, dest.path, err, settingsURL())
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
		created.Name, created.ID, created.Scope, created.ObfuscatedValue, dest.path)
	return nil
}

// settingsURL is the web app page where a person manages API keys.
func settingsURL() string {
	return strings.TrimRight(config.APIURL(), "/") + "/settings/api-keys"
}

// stdioPaths are the spellings of the process's own standard streams and
// terminal that --out rejects by name, before a stat could resolve them to a
// device or a pipe and reject them less clearly.
var stdioPaths = map[string]bool{
	"/dev/stdin":      true,
	"/dev/stdout":     true,
	"/dev/stderr":     true,
	"/dev/fd/0":       true,
	"/dev/fd/1":       true,
	"/dev/fd/2":       true,
	"/proc/self/fd/0": true,
	"/proc/self/fd/1": true,
	"/proc/self/fd/2": true,
	"/dev/tty":        true,
	"/dev/console":    true,
}

// keyFile is a 0600 temp file next to the requested path, which commit fills
// and moves into place, so the key is never in a file anyone else can read
// and the requested path never holds a partial key.
type keyFile struct {
	path  string
	tmp   *os.File
	force bool
}

// prepareKeyFile checks that path can take the key and opens the temp file
// that will become it. It refuses stdout, a path that is not a regular file,
// and (without force) a path that already exists.
func prepareKeyFile(path string, force bool) (*keyFile, error) {
	if path == "" {
		return nil, fmt.Errorf("--out must name a file")
	}
	if path == "-" {
		return nil, fmt.Errorf("--out cannot be stdout: the key is written only to a file")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolving --out: %w", err)
	}
	if stdioPaths[abs] {
		return nil, fmt.Errorf("--out cannot be %s: the key is written only to a regular file", abs)
	}

	// Stat follows a symlink, so a link to a terminal or a pipe is refused
	// too. --force replaces a regular file and nothing else.
	info, err := os.Stat(abs)
	switch {
	case err == nil && !info.Mode().IsRegular():
		return nil, fmt.Errorf("--out %s is not a regular file", abs)
	case err == nil && !force:
		return nil, fmt.Errorf("%s already exists; pass --force to replace it", abs)
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		return nil, fmt.Errorf("checking --out: %w", err)
	}

	// CreateTemp opens with mode 0600 from the start. The name starts with a
	// dot so a crash between create and rename leaves a hidden file.
	tmp, err := os.CreateTemp(filepath.Dir(abs), "."+filepath.Base(abs)+".tmp-*")
	if err != nil {
		return nil, fmt.Errorf("cannot write a file next to %s: %w", abs, err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, fmt.Errorf("setting permissions on %s: %w", tmp.Name(), err)
	}
	return &keyFile{path: abs, tmp: tmp, force: force}, nil
}

// commit writes the key and a trailing newline to the temp file and moves it
// to the requested path. Without force the move is a hard link, which fails
// rather than replacing a file that appeared since prepareKeyFile looked.
// Errors name paths only, never the key.
func (k *keyFile) commit(key string) error {
	if _, err := k.tmp.WriteString(key + "\n"); err != nil {
		return err
	}
	if err := k.tmp.Sync(); err != nil {
		return err
	}
	if err := k.tmp.Close(); err != nil {
		return err
	}
	if k.force {
		return os.Rename(k.tmp.Name(), k.path)
	}
	if err := os.Link(k.tmp.Name(), k.path); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%s was created by something else in the meantime", k.path)
		}
		// Some filesystems have no hard links. The existence check in
		// prepareKeyFile still stands; only the race it guards is reopened.
		return os.Rename(k.tmp.Name(), k.path)
	}
	return nil
}

// discard removes the temp file, if commit has not moved it away. It runs on
// every return, so a failed run leaves no copy of the key behind.
func (k *keyFile) discard() {
	k.tmp.Close()
	os.Remove(k.tmp.Name())
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
