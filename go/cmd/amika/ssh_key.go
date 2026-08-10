package main

import (
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

// sshKeyPushJSON is the JSON emitted by `secret ssh-key push`.
type sshKeyPushJSON struct {
	Status string `json:"status"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Scope  string `json:"scope"`
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

A key is identified by its name. Pushing a name that already exists requires
--force, which replaces that key's material.

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

			fromFile, _ := cmd.Flags().GetString("from-file")
			if strings.TrimSpace(fromFile) == "" {
				paths := basedir.New("")
				identityPath, err := paths.SSHIdentityFile()
				if err != nil {
					return err
				}
				fromFile = identityPath + ".pub"
			}
			raw, err := os.ReadFile(fromFile)
			if err != nil {
				return fmt.Errorf("reading public key %s: %w", fromFile, err)
			}
			// Validate locally so a typo fails before it reaches the API, and
			// so the uploaded value is the same canonical form the server
			// stores (comment stripped).
			publicKey := apiclient.CanonicalEd25519PublicKey(string(raw))
			if publicKey == "" {
				return fmt.Errorf("%s is not a valid ed25519 public key", fromFile)
			}

			client := runmode.NewRemoteClient()
			force, _ := cmd.Flags().GetBool("force")
			existing, err := client.ListSSHPublicKeys()
			if err != nil {
				return err
			}
			replaced := false
			for _, item := range existing {
				if item.Name != name {
					continue
				}
				if !force {
					return fmt.Errorf("an SSH key named %q already exists; pass --force to replace it", name)
				}
				replaced = true
			}

			// The create endpoint upserts by name, so --force does not delete
			// first; it only authorizes the overwrite.
			summary, err := client.CreateSSHPublicKey(apiclient.CreateSSHPublicKeyRequest{
				Name:      name,
				PublicKey: publicKey,
			})
			if err != nil {
				return err
			}
			status := "created"
			if replaced {
				status = "updated"
			}
			if format.IsJSON() {
				return format.JSON(cmd.OutOrStdout(), sshKeyPushJSON{
					Status: status,
					ID:     summary.ID,
					Name:   summary.Name,
					Scope:  summary.Scope,
				})
			}
			verb := "Created"
			if replaced {
				verb = "Updated"
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s SSH public key %q from %s\n", verb, summary.Name, fromFile)
			return nil
		},
	}
	cmd.Flags().String("name", "default", "Name for the uploaded public key")
	cmd.Flags().String("from-file", "", "Public key file to upload (default ~/.ssh/amika_id_ed25519.pub)")
	cmd.Flags().Bool("force", false, "Replace an existing SSH key with the same name")
	return cmd
}

func newSSHKeyListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List uploaded SSH public keys",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
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
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete an SSH public key by ID",
		Long: `Delete an SSH public key by ID.

Run "amika secret ssh-key list" to find the ID. Sandboxes that are already
running keep the key until they are provisioned again.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			format, err := output.FormatFrom(cmd)
			if err != nil {
				return err
			}
			if err := runmode.NewRemoteClient().DeleteSSHPublicKey(args[0]); err != nil {
				return err
			}
			if format.IsJSON() {
				return format.JSON(cmd.OutOrStdout(), output.ItemResult{Name: args[0], Status: "deleted"})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Deleted SSH public key %s\n", args[0])
			return nil
		},
	}
}

// abbreviateSSHKey shortens the base64 blob so a listing stays one line per
// key while still showing enough tail to tell two keys apart.
func abbreviateSSHKey(publicKey string) string {
	fields := strings.Fields(publicKey)
	if len(fields) < 2 || len(fields[1]) <= 20 {
		return publicKey
	}
	return fmt.Sprintf("%s %s...%s", fields[0], fields[1][:8], fields[1][len(fields[1])-12:])
}
