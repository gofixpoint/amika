package sandboxcmd

// sandbox_ssh.go implements sandbox SSH and editor connection commands.

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/gofixpoint/amika/internal/apiclient"
	"github.com/gofixpoint/amika/internal/runmode"
	"github.com/spf13/cobra"
)

func execSSH(client *apiclient.Client, name string, forcePTY bool, extraArgs []string) error {
	info, err := client.GetSSH(name)
	if err != nil {
		return err
	}
	if info.SSHDestination == "" {
		return fmt.Errorf("server returned empty SSH destination")
	}

	sshArgs := strings.Fields(info.SSHDestination)

	if forcePTY {
		dest := sshArgs[len(sshArgs)-1]
		sshArgs = append(sshArgs[:len(sshArgs)-1], "-t", dest)
	}

	if len(extraArgs) > 0 {
		sshArgs = append(sshArgs, extraArgs...)
	}

	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}
	return syscall.Exec(sshBin, append([]string{"ssh"}, sshArgs...), os.Environ())
}

var sandboxSSHCmd = &cobra.Command{
	Use:   "ssh <name> [-- <command>...]",
	Short: "SSH into a remote sandbox",
	Long: `Connect to a remote sandbox via SSH, or revoke SSH access.
Optionally pass a command to execute on the remote sandbox instead of opening an interactive session.

Use -t to force pseudo-terminal allocation, which is useful for running interactive
programs on the remote sandbox (equivalent to ssh -t).

Examples:
  amika sandbox ssh my-sandbox
  amika sandbox ssh -t my-sandbox -- top
  amika sandbox ssh my-sandbox -- ls -la
  amika sandbox ssh my-sandbox --revoke`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]

		mode := runmode.Resolve(cmd)
		if mode == runmode.Local {
			return fmt.Errorf("SSH access requires a remote sandbox; omit --local")
		}
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
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

		revoke, _ := cmd.Flags().GetBool("revoke")
		if revoke {
			info, err := client.GetSSH(name)
			if err != nil {
				return err
			}
			if info.Token == "" {
				return fmt.Errorf("no SSH token to revoke for sandbox %q", name)
			}
			if err := client.RevokeSSH(name, info.Token); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "SSH access revoked for sandbox %q\n", name)
			return nil
		}

		forcePTY, _ := cmd.Flags().GetBool("t")
		var extraArgs []string
		if len(args) > 1 {
			extraArgs = args[1:]
		}
		return execSSH(client, name, forcePTY, extraArgs)
	},
}

var sandboxCodeCmd = &cobra.Command{
	Use:   "code <name>",
	Short: "Open a remote sandbox in an editor via SSH",
	Long: `Open a remote sandbox in an editor (e.g. Cursor) using SSH remote access.

Examples:
  amika sandbox code my-sandbox
  amika sandbox code my-sandbox --editor=cursor`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		editor, _ := cmd.Flags().GetString("editor")

		if editor != "cursor" {
			return fmt.Errorf("unsupported editor %q; currently only \"cursor\" is supported", editor)
		}

		mode := runmode.Resolve(cmd)
		if mode == runmode.Local {
			return fmt.Errorf("code command requires a remote sandbox; omit --local")
		}
		if err := runmode.RequireAuth(mode, defaultAuthChecker); err != nil {
			return err
		}

		if _, err := exec.LookPath("cursor"); err != nil {
			return fmt.Errorf("cursor CLI is not installed or not in PATH; install it from Cursor > Settings > Extensions > cursor-cli")
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		info, err := client.GetSSH(name)
		if err != nil {
			return err
		}

		if info.SSHDestination == "" {
			return fmt.Errorf("server returned empty SSH destination")
		}

		fields := strings.Fields(info.SSHDestination)
		remoteHost := fields[len(fields)-1]

		remotePath := "/home/amika/workspace"
		if info.RepoName != "" {
			remotePath = remotePath + "/" + info.RepoName
		}

		cursorCmd := exec.Command("cursor", "--remote", "ssh-remote+"+remoteHost, remotePath)
		cursorCmd.Stdin = os.Stdin
		cursorCmd.Stdout = os.Stdout
		cursorCmd.Stderr = os.Stderr

		fmt.Fprintf(cmd.OutOrStdout(), "Opening sandbox %q in Cursor via SSH (%s)...\n", name, remoteHost)
		fmt.Fprintf(cmd.OutOrStdout(), "Running: cursor --remote ssh-remote+%s %s\n", remoteHost, remotePath)
		fmt.Fprintf(cmd.OutOrStdout(), "Hint: if the file explorer is not visible, press Cmd+Shift+E in Cursor to open it.\n")
		if err := cursorCmd.Run(); err != nil {
			return fmt.Errorf("cursor failed: %w\n\nMake sure the \"Remote - SSH\" extension is installed in Cursor", err)
		}
		return nil
	},
}
