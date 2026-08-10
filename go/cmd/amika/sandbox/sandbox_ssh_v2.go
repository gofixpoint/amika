package sandboxcmd

import (
	"fmt"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var sandboxSSHV2Cmd = &cobra.Command{
	Use:   "sshv2 [flags] <name> [-- <command>...]",
	Short: "SSH through the beta direct WebSocket transport",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if runmode.Resolve(cmd) == runmode.Local {
			return fmt.Errorf("direct WebSocket SSH requires a remote sandbox")
		}
		if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
			return err
		}
		if err := output.RejectFlag(cmd); err != nil {
			return err
		}
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}
		sandbox, err := client.GetSandbox(args[0])
		if err != nil {
			return err
		}
		alias, err := ssh.PrepareSessionTarget(
			basedir.New(""),
			client,
			sandbox.Name,
			sandbox.ID,
		)
		if err != nil {
			return err
		}
		forcePTY, _ := cmd.Flags().GetBool("t")
		return ssh.ExecSessionSSH(alias, forcePTY, args[1:])
	},
}

var sandboxCodeV2Cmd = &cobra.Command{
	Use:   "codev2 <name>",
	Short: "Open a remote sandbox in an editor over the beta direct WebSocket transport",
	Long: `Open a remote sandbox in an editor or coding agent over the beta direct
WebSocket SSH transport. It supports the same editors and flags as "sandbox code",
but bypasses provider-native SSH access.

The command creates a managed SSH alias backed by Amika's WebSocket proxy, then
hands that alias to the selected editor. It requires an SSH identity from
"amika secret ssh-keygen".

Examples:
  amika sandbox codev2 my-sandbox
  amika sandbox codev2 my-sandbox --editor=cursor
  amika sandbox codev2 my-sandbox --editor=claude
  amika sandbox codev2 my-sandbox --editor=codex`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := output.RejectJSON(cmd); err != nil {
			return err
		}
		editor, _ := cmd.Flags().GetString("editor")
		if err := validateEditor(editor); err != nil {
			return err
		}
		if runmode.Resolve(cmd) == runmode.Local {
			return fmt.Errorf("direct WebSocket SSH requires a remote sandbox")
		}
		if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}
		paths := basedir.New("")
		sshTarget, err := resolveSandboxV2SSHAlias(client, paths, args[0])
		if err != nil {
			return err
		}
		pathOverride, _ := cmd.Flags().GetString("path")
		return openSandboxInEditor(cmd, editor, paths, sshTarget, pathOverride)
	},
}

// sshV2Client is the subset of apiclient.Client codev2 needs to prepare a
// direct-session SSH alias for an editor.
type sshV2Client interface {
	ssh.SessionCreator
	GetSandbox(name string) (*apiclient.RemoteSandbox, error)
}

// prepareSessionTarget is a seam around the shared v2 setup used by codev2,
// sshv2, and scpv2. Keeping it replaceable lets the command package verify its
// alias handoff without re-testing the session package's key and pinning logic.
var prepareSessionTarget = ssh.PrepareSessionTarget

// resolveSandboxV2SSHAlias prepares the same direct-session alias used by
// sshv2 and scpv2. Editors subsequently use system OpenSSH, which invokes the
// managed alias's ProxyCommand once it dials the host.
func resolveSandboxV2SSHAlias(client sshV2Client, paths basedir.Paths, name string) (sandboxSSHAlias, error) {
	sandbox, err := client.GetSandbox(name)
	if err != nil {
		return sandboxSSHAlias{}, err
	}
	alias, err := prepareSessionTarget(paths, client, sandbox.Name, sandbox.ID)
	if err != nil {
		return sandboxSSHAlias{}, err
	}
	repoName := ""
	if sandbox.RepoName != nil {
		repoName = *sandbox.RepoName
	}
	return sandboxSSHAlias{alias: alias, sandboxName: sandbox.Name, repoName: repoName}, nil
}
