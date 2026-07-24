package sandboxcmd

// sandbox_ssh.go implements sandbox SSH and editor connection commands.

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"runtime"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/appcfg"
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

// supportedEditors lists the values accepted by `sandbox code --editor`.
var supportedEditors = []string{"cursor", "claude", "codex"}

var sandboxCodeCmd = &cobra.Command{
	Use:   "code <name>",
	Short: "Open a remote sandbox in an editor or agent via SSH",
	Long: `Open a remote sandbox in an editor or coding agent using SSH remote access.

Supported --editor values:
  cursor   launch Cursor connected to the sandbox (default)
  claude   register the sandbox as a Claude Desktop SSH environment
  codex    expose the sandbox to Codex as an SSH connection

For claude and codex, the command writes the local app config so the sandbox
appears as a remote environment; select it in the app to start the session.

Examples:
  amika sandbox code my-sandbox
  amika sandbox code my-sandbox --editor=cursor
  amika sandbox code my-sandbox --editor=claude
  amika sandbox code my-sandbox --editor=codex`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]
		editor, _ := cmd.Flags().GetString("editor")
		switch editor {
		case "cursor", "claude", "codex":
		default:
			return fmt.Errorf("unsupported editor %q; supported editors are %q", editor, supportedEditors)
		}

		mode := runmode.Resolve(cmd)
		if mode == runmode.Local {
			return fmt.Errorf("code command requires a remote sandbox; omit --local")
		}
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
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

		pathOverride, _ := cmd.Flags().GetString("path")
		paths := basedir.New("")

		switch editor {
		case "cursor":
			return openSandboxInCursor(cmd, client, paths, name, pathOverride)
		case "claude":
			return openSandboxInClaude(cmd, client, paths, name, pathOverride)
		case "codex":
			return openSandboxInCodex(cmd, client, paths, name, pathOverride)
		}
		return nil
	},
}

// sandboxSSHAlias is the stable Amika-managed SSH alias for a sandbox plus the
// identity needed to label and locate it, shared by every `code` editor.
type sandboxSSHAlias struct {
	alias       string
	sandboxName string
	repoName    string
}

// sshInfoClient is the subset of apiclient.Client used to resolve SSH aliases.
type sshInfoClient interface {
	GetSSH(name string) (*apiclient.SSHInfo, error)
	GetSandbox(name string) (*apiclient.RemoteSandbox, error)
}

// resolveSandboxSSHAlias mints SSH access for the sandbox and upserts it into
// the Amika-managed SSH config, returning the stable `amika-<id>` Host alias.
// Every `code` editor connects through this single alias.
func resolveSandboxSSHAlias(client sshInfoClient, paths basedir.Paths, name string) (sandboxSSHAlias, error) {
	info, err := client.GetSSH(name)
	if err != nil {
		return sandboxSSHAlias{}, err
	}
	if info.SSHDestination == "" {
		return sandboxSSHAlias{}, fmt.Errorf("server returned empty SSH destination")
	}

	sandboxID := info.SandboxID
	sandboxName := info.SandboxName
	if sandboxID == "" {
		sb, err := client.GetSandbox(name)
		if err != nil {
			return sandboxSSHAlias{}, fmt.Errorf("look up sandbox id: %w", err)
		}
		sandboxID = sb.ID
		sandboxName = sb.Name
	}
	if sandboxName == "" {
		sandboxName = name
	}

	entry, err := ssh.NewHostEntry(sandboxID, sandboxName, info.SSHDestination, info.ExpiresAt)
	if err != nil {
		return sandboxSSHAlias{}, err
	}
	alias, err := ssh.UpsertHost(paths, entry)
	if err != nil {
		return sandboxSSHAlias{}, fmt.Errorf("write managed SSH config: %w", err)
	}

	return sandboxSSHAlias{alias: alias, sandboxName: sandboxName, repoName: info.RepoName}, nil
}

// openSandboxInCursor launches Cursor connected to the sandbox over SSH.
func openSandboxInCursor(cmd *cobra.Command, client sshInfoClient, paths basedir.Paths, name, pathOverride string) error {
	if _, err := exec.LookPath("cursor"); err != nil {
		return fmt.Errorf("cursor CLI is not installed or not in PATH; install it from Cursor > Settings > Extensions > cursor-cli")
	}

	target, err := prepareCursorSSHTarget(client, paths, name, pathOverride)
	if err != nil {
		return err
	}

	cursorCmd := exec.Command("cursor", "--remote", "ssh-remote+"+target.alias, target.remotePath)
	cursorCmd.Stdin = os.Stdin
	cursorCmd.Stdout = os.Stdout
	cursorCmd.Stderr = os.Stderr

	fmt.Fprintf(cmd.OutOrStdout(), "Opening sandbox %q in Cursor via SSH (%s)...\n", name, target.alias)
	fmt.Fprintf(cmd.OutOrStdout(), "Running: cursor --remote ssh-remote+%s %s\n", target.alias, target.remotePath)
	fmt.Fprintf(cmd.OutOrStdout(), "Hint: if the file explorer is not visible, press Cmd+Shift+E in Cursor to open it.\n")
	if err := cursorCmd.Run(); err != nil {
		return fmt.Errorf("cursor failed: %w\n\nMake sure the \"Remote - SSH\" extension is installed in Cursor", err)
	}
	return nil
}

// openSandboxInClaude registers the sandbox as an SSH environment in Claude
// Desktop's settings and opens the app so the user can select it. Claude
// Desktop cannot be pointed at an SSH environment via a deep link, so the user
// picks it from the environment dropdown to start the remote session.
func openSandboxInClaude(cmd *cobra.Command, client sshInfoClient, paths basedir.Paths, name, pathOverride string) error {
	target, err := resolveSandboxSSHAlias(client, paths, name)
	if err != nil {
		return err
	}

	host := appcfg.ClaudeSSHHost{
		ID:             target.alias,
		Name:           "Amika: " + target.sandboxName,
		SSHHost:        target.alias,
		StartDirectory: resolveRemoteWorkspacePath(target.repoName, pathOverride),
	}
	if _, err := appcfg.UpsertClaudeSSHConfig(paths, host); err != nil {
		return fmt.Errorf("write Claude settings: %w", err)
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "Registered SSH environment %q for sandbox %q in Claude Desktop.\n", host.Name, name)
	if err := openApp("claude://code/new"); err != nil {
		fmt.Fprintf(out, "Could not launch Claude Desktop automatically (%v); open it yourself.\n", err)
	} else {
		fmt.Fprintf(out, "Opening Claude Desktop...\n")
	}
	fmt.Fprintf(out, "In the Code tab, choose %q from the environment dropdown to start the remote session.\n", host.Name)
	return nil
}

// openSandboxInCodex enables Codex's remote-connections feature (the SSH alias
// is already in ~/.ssh/config via the Amika include) and opens the app. Codex
// has no deep link to connect to a host, so the user enables the alias under
// Settings > Connections.
func openSandboxInCodex(cmd *cobra.Command, client sshInfoClient, paths basedir.Paths, name, pathOverride string) error {
	target, err := resolveSandboxSSHAlias(client, paths, name)
	if err != nil {
		return err
	}

	if _, err := appcfg.EnableCodexRemoteConnections(paths); err != nil {
		return fmt.Errorf("enable Codex remote connections: %w", err)
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "Enabled Codex remote connections; SSH host %q for sandbox %q is available from ~/.ssh/config.\n", target.alias, name)
	if err := openApp("codex://"); err != nil {
		fmt.Fprintf(out, "Could not launch Codex automatically (%v); open it yourself.\n", err)
	} else {
		fmt.Fprintf(out, "Opening Codex...\n")
	}
	fmt.Fprintf(out, "In Codex, open Settings > Connections, enable host %q, and choose a remote folder (e.g. %s).\n",
		target.alias, resolveRemoteWorkspacePath(target.repoName, pathOverride))
	return nil
}

type cursorSSHTarget struct {
	alias      string
	remotePath string
}

func prepareCursorSSHTarget(client sshInfoClient, paths basedir.Paths, name string, pathOverride string) (cursorSSHTarget, error) {
	target, err := resolveSandboxSSHAlias(client, paths, name)
	if err != nil {
		return cursorSSHTarget{}, err
	}
	return cursorSSHTarget{
		alias:      target.alias,
		remotePath: resolveRemoteWorkspacePath(target.repoName, pathOverride),
	}, nil
}

// resolveRemoteWorkspacePath computes the remote path to open in the editor.
// An absolute pathOverride is used verbatim; a relative one is joined onto
// /home/amika so that e.g. "workspace/biz" → "/home/amika/workspace/biz".
// When pathOverride is empty the default workspace path is used, optionally
// extended with the repo name.
func resolveRemoteWorkspacePath(repoName, pathOverride string) string {
	if pathOverride != "" {
		if path.IsAbs(pathOverride) {
			return pathOverride
		}
		return path.Join("/home/amika", pathOverride)
	}
	remotePath := "/home/amika/workspace"
	if repoName != "" {
		remotePath = remotePath + "/" + repoName
	}
	return remotePath
}

// openApp hands a URL scheme to the OS so the associated desktop app launches
// (or focuses). Best-effort: it returns once the opener starts, not when the
// app is ready. It is a var so tests can stub out the real launch.
var openApp = func(url string) error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		c = exec.Command("open", url)
	case "linux":
		c = exec.Command("xdg-open", url)
	case "windows":
		// `start` treats its first quoted argument as the window title, so pass
		// an empty title before the URL.
		c = exec.Command("cmd", "/c", "start", "", url)
	default:
		return fmt.Errorf("unsupported platform %q", runtime.GOOS)
	}
	return c.Start()
}
