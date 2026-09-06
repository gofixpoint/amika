package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// uploadStatus reports what an upload did, given the keys already stored.
// The create endpoint upserts by name, so re-uploading the same material
// under the same name is a no-op rather than a conflict; only material that
// would actually change requires --force.
type uploadStatus struct {
	status   string
	conflict bool
}

func classifyUpload(existing []apiclient.SSHPublicKeySummary, name, publicKey string) uploadStatus {
	for _, item := range existing {
		if item.Name != name {
			continue
		}
		if item.PublicKey == publicKey {
			return uploadStatus{status: "unchanged"}
		}
		return uploadStatus{status: "updated", conflict: true}
	}
	return uploadStatus{status: "created"}
}

// newSSHKeyCmd builds the `secret ssh-key` command group. Every subcommand is
// built by a factory because the whole secret tree is instantiated twice, once
// under `secret` and once under the hidden `secrets` alias, and a cobra command
// cannot belong to two parents.
func newSSHKeyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ssh-key",
		Short: "Manage user-owned SSH public keys",
		Long: `Manage the SSH public keys that authorize access to your sandboxes.

Only public keys are ever uploaded; private key material stays on this
machine.`,
	}
	cmd.AddCommand(newSSHKeyPushCmd())
	cmd.AddCommand(newSSHKeygenCmdAs("create"))
	cmd.AddCommand(newSSHKeyListCmd())
	cmd.AddCommand(newSSHKeyDeleteCmd())
	return cmd
}

func newSSHKeyPushCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "push",
		Short: "Upload an existing SSH public key",
		Long: `Upload an SSH public key that already exists on this machine.

Reads ~/.ssh/amika_id_ed25519.pub unless --from-file names another file. Use
"amika secret ssh-key create" to generate a new keypair instead.

The first push on a machine also registers the key locally, the way
"ssh-key create" does: the managed SSH entry in ~/.ssh/amika.conf is written to
authenticate with the private half beside the .pub file, and ~/.ssh/config is
given the Include that pulls it in. That is what lets an app resolve an
"amika" host alias on a machine where no sandbox command has run yet.

Later pushes leave that entry alone. Uploaded keys are a set, so pushing a
second key authorizes it alongside the first; the entry names the one identity
every connection authenticates with, and re-pointing it would cut off sandboxes
provisioned against the previous key. Use "ssh-key create" to change it.

A .pub with no usable private key beside it is still uploaded; only the local
registration is skipped.

A key is identified by its name. Re-uploading the same key material under an
existing name is a no-op; replacing an existing name with different material
requires --force.

Examples:
  amika secret ssh-key push
  amika secret ssh-key push --name laptop --from-file ~/.ssh/id_ed25519.pub
  amika secret ssh-key push --name laptop --force`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
				return err
			}
			format, err := output.FormatFrom(cmd)
			if err != nil {
				return err
			}
			name, _ := cmd.Flags().GetString("name")
			name = strings.TrimSpace(name)
			if name == "" {
				return fmt.Errorf("--name must not be empty")
			}

			paths := basedir.New("")
			fromFile, _ := cmd.Flags().GetString("from-file")
			fromFile = strings.TrimSpace(fromFile)
			if fromFile == "" {
				identityPath, err := paths.SSHIdentityFile()
				if err != nil {
					return err
				}
				fromFile = identityPath + ".pub"
			}
			raw, err := os.ReadFile(fromFile)
			if err != nil {
				// os.ReadFile already embeds the path in its error.
				return fmt.Errorf("reading public key: %w", err)
			}
			// Validate locally so a typo fails before it reaches the API, and
			// so the uploaded value is the same canonical form the server
			// stores (comment stripped).
			publicKey := apiclient.CanonicalEd25519PublicKey(string(raw))
			if publicKey == "" {
				return fmt.Errorf("%s is not a valid ed25519 public key", fromFile)
			}

			// Decide the entry before uploading, for the reason `ssh-keygen`
			// validates before it uploads: a config that cannot be written
			// must be known while the stored key is still the one the current
			// config selects. Unlike keygen, a failure here is not fatal — the
			// upload is what this command is for, and a public key whose
			// private half is elsewhere is a legitimate thing to push — so the
			// reason is carried and reported instead.
			plan, planErr := planSSHEntry(paths, fromFile)

			force, _ := cmd.Flags().GetBool("force")
			summary, status, err := uploadSSHPublicKey(name, publicKey, force)
			if err != nil {
				return err
			}

			// The same writer `secret ssh-keygen` uses, so a key that arrives
			// by push leaves the machine in the state a generated one does:
			// there is one managed SSH entry, written in one place.
			//
			// Not fatal, though the resolution above already caught the
			// foreseeable refusals: past this point the key is stored, and
			// exiting non-zero would tell a caller its upload had failed when
			// it had not. What is left to go wrong here is a filesystem the
			// command cannot repair anyway.
			writeErr := error(nil)
			if planErr == nil {
				writeErr = ssh.ConfigureSession(paths, plan.session)
			}

			if format.IsJSON() {
				// Remote-backed commands emit the API's response schema
				// unchanged (AGENTS.md "CLI Output Format"), so the
				// created/updated distinction — and every line below — stay in
				// the text output only. The JSON models the stored key, which
				// is what a scripted caller asked for and what did happen.
				return format.JSON(cmd.OutOrStdout(), summary)
			}
			out := cmd.OutOrStdout()
			fmt.Fprintf(out, "%s SSH public key %q from %s\n",
				uploadVerb(status), summary.Name, fromFile)
			// Said after the upload it qualifies, because the upload is what
			// the reader asked for and it did happen.
			fmt.Fprintln(out, sshEntryNotice(plan, planErr, writeErr))
			return nil
		},
	}
	cmd.Flags().String("name", "default", "Name for the uploaded public key")
	cmd.Flags().String("from-file", "", "Public key file to upload (default ~/.ssh/amika_id_ed25519.pub)")
	cmd.Flags().Bool("force", false, "Replace an existing SSH key with the same name")
	return cmd
}

// sshEntryPlan is what a push intends to do about the managed SSH entry: the
// identity the entry will authenticate with once written, and whether this
// push is what chose it.
type sshEntryPlan struct {
	session ssh.SessionConfig
	// adopted is true when the machine had no managed identity and the pushed
	// key becomes it. False means one was already registered and this push
	// leaves it selecting whatever it selected before.
	adopted bool
}

// planSSHEntry decides what a push should register.
//
// The first push on a machine adopts its key. Nothing has yet said which
// private key the managed config authenticates with, the key being uploaded is
// the only sensible answer, and writing it is what lets the deep-link
// launchers (cmux, Cursor) resolve an alias on a machine where no sandbox
// command has run.
//
// Every later push leaves that choice alone, so repeat pushes are idempotent.
// This is the asymmetry that makes it necessary: uploaded keys are a *set*,
// keyed by name, so `push --name work` adds an authorized key rather than
// replacing one — while the session identity is a single value shared by every
// environment, rendered under `IdentitiesOnly yes`. Adopting each new key would
// silently re-point every sandbox connection at the newest one and lock the
// user out of sandboxes provisioned against the previous. `secret ssh-keygen`
// remains the command for deliberately changing which identity is in effect.
//
// A push that adopts nothing needs no private key at all, which is why the
// resolution is behind the check rather than in front of it.
func planSSHEntry(paths basedir.Paths, publicKeyPath string) (sshEntryPlan, error) {
	state, err := ssh.LoadState(paths)
	if err != nil {
		return sshEntryPlan{}, err
	}
	if state.SessionConfig != nil {
		return sshEntryPlan{session: *state.SessionConfig}, nil
	}
	session, err := localSSHEntryFor(paths, publicKeyPath)
	if err != nil {
		return sshEntryPlan{}, err
	}
	return sshEntryPlan{session: session, adopted: true}, nil
}

// sshEntryNotice is the one line a push says about the managed SSH entry.
//
// A push that changed nothing still says which identity the entry holds. The
// reader has just uploaded a key and the honest answer is often "not that one"
// — a `--force` replace can even leave the entry selecting material the server
// no longer stores — and naming the file is what lets them see it.
func sshEntryNotice(plan sshEntryPlan, planErr, writeErr error) string {
	switch {
	case planErr != nil:
		return fmt.Sprintf("Left the managed SSH host entry alone: %v", planErr)
	case writeErr != nil:
		return fmt.Sprintf("Could not write the managed SSH host entry: %v", writeErr)
	case plan.adopted:
		return fmt.Sprintf("Registered the managed SSH host entry; it authenticates with %s.",
			plan.session.IdentityFile)
	default:
		return fmt.Sprintf("The managed SSH host entry is unchanged; it authenticates with %s.",
			plan.session.IdentityFile)
	}
}

// localSSHEntryFor resolves the managed SSH entry an uploaded public key
// implies on this machine: the private half beside the .pub is the identity
// the entry authenticates with. `ImportIdentity` is what establishes that the
// pair is real — the private key exists, is owner-only, is an unencrypted
// Ed25519 key, and matches the public half — so a push whose .pub has no
// usable partner is told apart from one that does, rather than registering an
// entry that selects a key OpenSSH cannot use.
//
// Both errors are wrapped with the path they are about, because unwrapped they
// name neither: `ImportIdentity` speaks of an "imported" key, which is keygen's
// vocabulary rather than push's, and a path OpenSSH cannot express comes back
// as "invalid Amika SSH host alias", naming an alias no one asked for.
func localSSHEntryFor(paths basedir.Paths, publicKeyPath string) (ssh.SessionConfig, error) {
	identityPath, _, err := ssh.ImportIdentity(publicKeyPath)
	if err != nil {
		return ssh.SessionConfig{}, fmt.Errorf("no usable private key beside %s: %w", publicKeyPath, err)
	}
	session, err := sshSessionFor(paths, identityPath)
	if err != nil {
		return ssh.SessionConfig{}, fmt.Errorf("cannot build an SSH config for %s: %w", identityPath, err)
	}
	return session, nil
}

// sshSessionFor builds the session config for a private key and checks that
// ConfigureSession would accept it, without writing anything. Both commands
// that upload a key — `ssh-key push` and `ssh-keygen` — go through it, so they
// cannot disagree about what an uploaded key implies locally, and both learn of
// a config OpenSSH cannot express before the remote key changes.
func sshSessionFor(paths basedir.Paths, identityPath string) (ssh.SessionConfig, error) {
	knownHostsPath, err := paths.SSHKnownHostsFile()
	if err != nil {
		return ssh.SessionConfig{}, err
	}
	session := ssh.SessionConfig{
		IdentityFile:   identityPath,
		KnownHostsFile: knownHostsPath,
	}
	if err := ssh.ValidateSessionConfig(session); err != nil {
		return ssh.SessionConfig{}, err
	}
	return session, nil
}

// uploadSSHPublicKey stores one public key under a name, refusing to replace
// different material under an existing name unless force is set. Shared by
// `ssh-key push` and the keygen path so the two cannot diverge on whether an
// overwrite needs authorizing.
func uploadSSHPublicKey(name, publicKey string, force bool) (*apiclient.SSHPublicKeySummary, string, error) {
	client := runmode.NewRemoteClient()
	existing, err := client.ListSSHPublicKeys()
	if err != nil {
		// A push should not read as a list failure.
		return nil, "", fmt.Errorf("checking for an existing key named %q: %w", name, err)
	}
	result := classifyUpload(existing, name, publicKey)
	if result.conflict && !force {
		return nil, "", fmt.Errorf(
			"an SSH key named %q already exists with different key material; pass --force to replace it", name)
	}

	// The create endpoint upserts by name, so --force does not delete first;
	// it only authorizes the overwrite, which keeps the replacement atomic.
	summary, err := client.CreateSSHPublicKey(apiclient.CreateSSHPublicKeyRequest{
		Name:      name,
		PublicKey: publicKey,
	})
	if err != nil {
		return nil, "", err
	}
	return summary, result.status, nil
}

func uploadVerb(status string) string {
	switch status {
	case "updated":
		return "Updated"
	case "unchanged":
		return "Reuploaded"
	default:
		return "Created"
	}
}

func newSSHKeyListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List uploaded SSH public keys",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
				return err
			}
			format, err := output.FormatFrom(cmd)
			if err != nil {
				return err
			}
			items, err := runmode.NewRemoteClient().ListSSHPublicKeys()
			if err != nil {
				return err
			}
			if format.IsJSON() {
				if items == nil {
					items = []apiclient.SSHPublicKeySummary{}
				}
				return format.JSON(cmd.OutOrStdout(), items)
			}
			if len(items) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "No SSH public keys found.")
				return nil
			}
			w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tNAME\tKEY")
			for _, item := range items {
				fmt.Fprintf(w, "%s\t%s\t%s\n", item.ID, item.Name, abbreviateSSHKey(item.PublicKey))
			}
			return w.Flush()
		},
	}
}

func newSSHKeyDeleteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete an SSH public key by ID",
		Long: `Delete an SSH public key by ID.

Run "amika secret ssh-key list" to find the ID. Sandboxes that are already
running keep the key until they are provisioned again, so this does not end
sessions that are already open.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
				return err
			}
			id := strings.TrimSpace(args[0])
			if id == "" {
				return fmt.Errorf("an SSH key ID is required")
			}
			format, err := output.FormatFrom(cmd)
			if err != nil {
				return err
			}
			force, _ := cmd.Flags().GetBool("force")
			if !force {
				if format.IsJSON() {
					return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete",
						output.FlagName, format)
				}
				reader := bufio.NewReader(cmd.InOrStdin())
				confirmed, err := confirmAction(
					fmt.Sprintf("Delete SSH public key %s?", id), reader)
				if err != nil {
					return err
				}
				if !confirmed {
					fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
					return nil
				}
			}
			if err := runmode.NewRemoteClient().DeleteSSHPublicKey(id); err != nil {
				return err
			}
			if format.IsJSON() {
				return format.JSON(cmd.OutOrStdout(), output.ItemResult{Name: id, Status: "deleted"})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Deleted SSH public key %s\n", id)
			return nil
		},
	}
	cmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
	return cmd
}

// abbreviateSSHKey shortens the base64 blob so a listing stays one line per
// key while still showing enough tail to tell two keys apart. The comment is
// dropped either way, so short and long keys render consistently.
func abbreviateSSHKey(publicKey string) string {
	fields := strings.Fields(publicKey)
	if len(fields) < 2 {
		return publicKey
	}
	// 8 + 3 + 12 is the width of an abbreviated blob; anything at or under
	// that is already at least as short, so leave it intact.
	if len(fields[1]) <= 23 {
		return fields[0] + " " + fields[1]
	}
	return fmt.Sprintf("%s %s...%s", fields[0], fields[1][:8], fields[1][len(fields[1])-12:])
}
