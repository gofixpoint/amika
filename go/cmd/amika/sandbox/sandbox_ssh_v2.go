package sandboxcmd

import (
	"fmt"

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
