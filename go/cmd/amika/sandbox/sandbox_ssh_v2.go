package sandboxcmd

import (
	"fmt"
	"os"

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
		alias, err := ssh.BuildSessionAlias(sandbox.Name, sandbox.ID)
		if err != nil {
			return err
		}
		paths := basedir.New("")
		state, err := ssh.LoadState(paths)
		if err != nil {
			return err
		}
		var sessionConfig ssh.SessionConfig
		if state.SessionConfig != nil {
			sessionConfig = *state.SessionConfig
		} else {
			identityFile, err := paths.SSHIdentityFile()
			if err != nil {
				return err
			}
			knownHostsFile, err := paths.SSHKnownHostsFile()
			if err != nil {
				return err
			}
			sessionConfig = ssh.SessionConfig{
				IdentityFile:   identityFile,
				KnownHostsFile: knownHostsFile,
				ProxyCommand:   "amika plumbing ssh-stdio-proxy %h",
			}
		}
		identityInfo, err := os.Stat(sessionConfig.IdentityFile)
		if err != nil || !identityInfo.Mode().IsRegular() || identityInfo.Mode().Perm()&0o077 != 0 {
			return fmt.Errorf("SSH identity is missing or unsafe; run \"amika secret ssh-keygen\"")
		}
		if err := ssh.ConfigureSession(paths, sessionConfig); err != nil {
			return err
		}
		if _, err := ssh.PrepareSessionHost(
			client,
			ssh.FileHostKeyPinStore{Path: sessionConfig.KnownHostsFile},
			sandbox.ID,
			alias,
		); err != nil {
			return err
		}
		forcePTY, _ := cmd.Flags().GetBool("t")
		return ssh.ExecSessionSSH(alias, forcePTY, args[1:])
	},
}
