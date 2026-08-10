package main

import (
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

func newSSHKeygenCmd() *cobra.Command {
	return newSSHKeygenCmdAs("ssh-keygen")
}

// newSSHKeygenCmdAs builds the keygen command under a caller-chosen verb, so
// `secret ssh-keygen` and `secret ssh-key create` share one implementation.
// Cobra commands cannot be attached to two parents, so each call site needs
// its own instance.
func newSSHKeygenCmdAs(use string) *cobra.Command {
	cmd := &cobra.Command{
		Use:   use,
		Short: "Create or import a user-owned SSH key",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
				return err
			}
			format, err := output.FormatFrom(cmd)
			if err != nil {
				return err
			}
			name, _ := cmd.Flags().GetString("name")
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("--name must not be empty")
			}
			paths := basedir.New("")
			identityPath, err := paths.SSHIdentityFile()
			if err != nil {
				return err
			}
			importPath, _ := cmd.Flags().GetString("import")
			var publicKey string
			if importPath == "" {
				publicKey, err = ssh.GenerateIdentity(identityPath)
			} else {
				identityPath, publicKey, err = ssh.ImportIdentity(importPath)
			}
			if err != nil {
				return err
			}
			knownHostsPath, err := paths.SSHKnownHostsFile()
			if err != nil {
				return err
			}
			if err := ssh.ConfigureSession(paths, ssh.SessionConfig{
				IdentityFile:   identityPath,
				KnownHostsFile: knownHostsPath,
			}); err != nil {
				return err
			}
			summary, err := runmode.NewRemoteClient().CreateSSHPublicKey(
				apiclient.CreateSSHPublicKeyRequest{Name: name, PublicKey: publicKey},
			)
			if err != nil {
				return err
			}
			if format.IsJSON() {
				return format.JSON(cmd.OutOrStdout(), summary)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "SSH public key %q uploaded; private key remains at %s.\n", summary.Name, identityPath)
			return nil
		},
	}
	cmd.Flags().String("import", "", "Import an existing .pub file instead of generating a key")
	cmd.Flags().String("name", "default", "Name for the uploaded public key")
	return cmd
}
