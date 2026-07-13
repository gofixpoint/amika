package sandboxcmd

// sandbox_ssh.go implements sandbox SSH and editor connection commands.

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var sandboxSSHCmd = &cobra.Command{
	Use:   "ssh [flags] <name> [-- <command>...]",
	Short: "SSH into a remote sandbox",
	Long: `Connect to a remote sandbox via SSH, or revoke SSH access.
Optionally pass a command to execute on the remote sandbox instead of opening an interactive session.

Use -t to force pseudo-terminal allocation, which is useful for running interactive
programs on the remote sandbox (equivalent to ssh -t).

Use --print to print the SSH connection string instead of connecting.

Examples:
  amika sandbox ssh my-sandbox
  amika sandbox ssh -t my-sandbox -- top
  amika sandbox ssh my-sandbox -- ls -la
  amika sandbox ssh --print my-sandbox
  amika sandbox ssh my-sandbox --revoke`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]

		mode := runmode.Resolve(cmd)
		if mode == runmode.Local {
			return fmt.Errorf("SSH access requires a remote sandbox; omit --local")
		}
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		if _, err := getRemoteTarget(cmd); err != nil {
			return err
		}

		client := runmode.NewRemoteClient()

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

		printOnly, _ := cmd.Flags().GetBool("print")
		if printOnly {
			info, err := client.GetSSH(name)
			if err != nil {
				return err
			}
			if info.SSHDestination == "" {
				return fmt.Errorf("server returned empty SSH destination")
			}
			fmt.Fprintln(cmd.OutOrStdout(), info.SSHDestination)
			return nil
		}

		forcePTY, _ := cmd.Flags().GetBool("t")
		var extraArgs []string
		if len(args) > 1 {
			extraArgs = args[1:]
		}
		return ssh.ExecSSH(client, name, forcePTY, extraArgs)
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
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		if _, err := exec.LookPath("cursor"); err != nil {
			return fmt.Errorf("cursor CLI is not installed or not in PATH; install it from Cursor > Settings > Extensions > cursor-cli")
		}

		if _, err := getRemoteTarget(cmd); err != nil {
			return err
		}

		client := runmode.NewRemoteClient()

		cursorTarget, err := prepareCursorSSHTarget(client, basedir.New(""), name)
		if err != nil {
			return err
		}

		cursorCmd := exec.Command("cursor", "--remote", "ssh-remote+"+cursorTarget.alias, cursorTarget.remotePath)
		cursorCmd.Stdin = os.Stdin
		cursorCmd.Stdout = os.Stdout
		cursorCmd.Stderr = os.Stderr

		fmt.Fprintf(cmd.OutOrStdout(), "Opening sandbox %q in Cursor via SSH (%s)...\n", name, cursorTarget.alias)
		fmt.Fprintf(cmd.OutOrStdout(), "Running: cursor --remote ssh-remote+%s %s\n", cursorTarget.alias, cursorTarget.remotePath)
		fmt.Fprintf(cmd.OutOrStdout(), "Hint: if the file explorer is not visible, press Cmd+Shift+E in Cursor to open it.\n")
		if err := cursorCmd.Run(); err != nil {
			return fmt.Errorf("cursor failed: %w\n\nMake sure the \"Remote - SSH\" extension is installed in Cursor", err)
		}
		return nil
	},
}

type cursorSSHTarget struct {
	alias      string
	remotePath string
}

func prepareCursorSSHTarget(client *apiclient.Client, paths basedir.Paths, name string) (cursorSSHTarget, error) {
	info, err := client.GetSSH(name)
	if err != nil {
		return cursorSSHTarget{}, err
	}
	if info.SSHDestination == "" {
		return cursorSSHTarget{}, fmt.Errorf("server returned empty SSH destination")
	}

	sandboxID := info.SandboxID
	sandboxName := info.SandboxName
	if sandboxID == "" {
		sb, err := client.GetSandbox(name)
		if err != nil {
			return cursorSSHTarget{}, fmt.Errorf("look up sandbox id: %w", err)
		}
		sandboxID = sb.ID
		sandboxName = sb.Name
	}
	if sandboxName == "" {
		sandboxName = name
	}

	entry, err := ssh.NewHostEntry(sandboxID, sandboxName, info.SSHDestination, info.ExpiresAt)
	if err != nil {
		return cursorSSHTarget{}, err
	}
	alias, err := ssh.UpsertHost(paths, entry)
	if err != nil {
		return cursorSSHTarget{}, fmt.Errorf("write managed SSH config: %w", err)
	}

	remotePath := "/home/amika/workspace"
	if info.RepoName != "" {
		remotePath = remotePath + "/" + info.RepoName
	}

	return cursorSSHTarget{alias: alias, remotePath: remotePath}, nil
}
