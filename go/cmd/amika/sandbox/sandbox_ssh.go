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
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/gofixpoint/amika/go/internal/wslbridge"
	"github.com/spf13/cobra"
)

// validateEditor checks that the requested editor is supported.
func validateEditor(editor string) error {
	switch editor {
	case "cursor", "vscode", "claude", "codex", "paseo":
		return nil
	default:
		return fmt.Errorf("unsupported editor %q; supported editors are %q", editor, supportedEditors)
	}
}

var supportedEditors = []string{"cursor", "vscode", "claude", "codex", "paseo"}

// maintainSSHHosts keeps maintenance failures from preventing an editor launch.
func maintainSSHHosts(cmd *cobra.Command, paths basedir.Paths, client *apiclient.Client, alias string) {
	if _, err := ssh.CollectGarbage(paths, client, ssh.GCOptions{KeepAlias: alias}); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not clean up SSH config: %v\n", err)
	}
}

// sandboxSSHAlias is the stable Amika-managed SSH alias for a sandbox plus the
// identity needed to label and locate it, shared by every editor `sandbox code` opens.
type sandboxSSHAlias struct {
	alias       string
	sandboxName string
	repoName    string
}

// openSandboxInEditor starts the selected editor with a prepared SSH target.
func openSandboxInEditor(cmd *cobra.Command, editor string, paths basedir.Paths, target sandboxSSHAlias, pathOverride string) error {
	switch editor {
	case "cursor":
		return openSandboxInCursorTarget(cmd, paths, target, pathOverride)
	case "vscode":
		return openSandboxInVSCodeTarget(cmd, paths, target, pathOverride)
	case "claude":
		return openSandboxInClaudeTarget(cmd, paths, target, pathOverride)
	case "codex":
		return openSandboxInCodexTarget(cmd, paths, target, pathOverride)
	case "paseo":
		return openSandboxInPaseoTarget(cmd, target)
	default:
		return fmt.Errorf("unsupported editor %q", editor)
	}
}

// openSandboxInCursorTarget launches Cursor connected to a prepared SSH target.
func openSandboxInCursorTarget(cmd *cobra.Command, paths basedir.Paths, target sandboxSSHAlias, pathOverride string) error {
	return launchRemoteSSHEditor(cmd, "cursor", "Cursor",
		"Run this from Cursor's command palette: \">Shell Command: Install 'cursor' command\"", paths, target, pathOverride)
}

// openSandboxInVSCodeTarget launches VS Code connected to a prepared SSH target.
func openSandboxInVSCodeTarget(cmd *cobra.Command, paths basedir.Paths, target sandboxSSHAlias, pathOverride string) error {
	return launchRemoteSSHEditor(cmd, "code", "VS Code",
		"the VS Code Command Palette: \"Shell Command: Install 'code' command in PATH\"", paths, target, pathOverride)
}

// The WSL seams isolate the editor launch from the Windows side, so tests
// can drive the handoff without interop.
var (
	wslIsWSL           = wslbridge.IsWSL
	wslResolveTarget   = wslbridge.ResolveTarget
	wslEditorExe       = wslbridge.EditorExe
	wslLaunchWindows   = wslbridge.LaunchDetached
	mirrorSSHToWindows = ssh.MirrorToWindows
)

// launchRemoteSSHEditor launches a VS Code-family editor (Cursor, VS Code)
// against a prepared SSH target. Both share VS Code's Remote-SSH CLI contract:
// <cli> --remote ssh-remote+<host> <path>.
func launchRemoteSSHEditor(cmd *cobra.Command, cli, name, installHint string, paths basedir.Paths, target sandboxSSHAlias, pathOverride string) error {
	launch, err := resolveEditorLauncher(cli, installHint, paths)
	if err != nil {
		return err
	}

	remotePath := resolveRemoteWorkspacePath(target.repoName, pathOverride)

	fmt.Fprintf(cmd.OutOrStdout(), "Opening sandbox %q in %s via SSH (%s)...\n", target.sandboxName, name, target.alias)
	fmt.Fprintf(cmd.OutOrStdout(), "Running: %s --remote ssh-remote+%s %s\n", cli, target.alias, remotePath)
	fmt.Fprintf(cmd.OutOrStdout(), "Hint: if the file explorer is not visible, press Cmd+Shift+E in %s to open it.\n", name)
	if err := launch("--remote", "ssh-remote+"+target.alias, remotePath); err != nil {
		return fmt.Errorf("%s failed: %w\n\nMake sure the \"Remote - SSH\" extension is installed in %s", cli, err, name)
	}
	return nil
}

// resolveEditorLauncher returns the function that starts the editor CLI with
// the Remote-SSH arguments. Normally that is the local CLI, run in the
// foreground; under WSL the editor is a Windows application instead, so the
// launch crosses the WSL boundary.
func resolveEditorLauncher(cli, installHint string, paths basedir.Paths) (func(args ...string) error, error) {
	if wslIsWSL() {
		return resolveWindowsEditorLauncher(cli, paths)
	}
	if _, err := exec.LookPath(cli); err != nil {
		return nil, fmt.Errorf("%s CLI is not installed or not in PATH; install it from %s", cli, installHint)
	}
	return func(args ...string) error {
		editorCmd := exec.Command(cli, args...)
		editorCmd.Stdin = os.Stdin
		editorCmd.Stdout = os.Stdout
		editorCmd.Stderr = os.Stderr
		return editorCmd.Run()
	}, nil
}

// resolveWindowsEditorLauncher prepares the Windows side of a WSL launch: it
// mirrors the SSH config, identity, and host-key pins to the Windows user's
// .ssh directory so the editor's own OpenSSH can reach the sandbox, then
// returns a launcher that opens the Windows editor on the desktop.
func resolveWindowsEditorLauncher(cli string, paths basedir.Paths) (func(args ...string) error, error) {
	windowsTarget, err := wslResolveTarget()
	if err != nil {
		return nil, fmt.Errorf("resolve the Windows side: %w", err)
	}
	if err := mirrorSSHToWindows(paths, windowsTarget); err != nil {
		return nil, fmt.Errorf("mirror SSH config to Windows: %w", err)
	}
	exe, err := wslEditorExe(cli)
	if err != nil {
		return nil, err
	}
	return func(args ...string) error { return wslLaunchWindows(exe, args...) }, nil
}

// openSandboxInClaudeTarget registers a prepared SSH target in Claude Desktop.
func openSandboxInClaudeTarget(cmd *cobra.Command, paths basedir.Paths, target sandboxSSHAlias, pathOverride string) error {
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
	fmt.Fprintf(out, "Registered SSH environment %q for sandbox %q in Claude Desktop.\n", host.Name, target.sandboxName)
	if err := openApp("claude://code/new"); err != nil {
		fmt.Fprintf(out, "Could not launch Claude Desktop automatically (%v); open it yourself.\n", err)
	} else {
		fmt.Fprintf(out, "Opening Claude Desktop...\n")
	}
	fmt.Fprintf(out, "In the Code tab, choose %q from the environment dropdown to start the remote session.\n", host.Name)
	return nil
}

// openSandboxInCodexTarget enables Codex remote connections for a prepared SSH target.
func openSandboxInCodexTarget(cmd *cobra.Command, paths basedir.Paths, target sandboxSSHAlias, pathOverride string) error {
	if _, err := appcfg.EnableCodexRemoteConnections(paths); err != nil {
		return fmt.Errorf("enable Codex remote connections: %w", err)
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "Enabled Codex remote connections; SSH host %q for sandbox %q is available from ~/.ssh/config.\n", target.alias, target.sandboxName)
	if err := openApp("codex://"); err != nil {
		fmt.Fprintf(out, "Could not launch Codex automatically (%v); open it yourself.\n", err)
	} else {
		fmt.Fprintf(out, "Opening Codex...\n")
	}
	fmt.Fprintf(out, "In Codex, open Settings > Connections, enable host %q, and choose a remote folder (e.g. %s).\n",
		target.alias, resolveRemoteWorkspacePath(target.repoName, pathOverride))
	return nil
}

// openSandboxInPaseoTarget prints the direct SSH host Paseo should register.
// Paseo does not currently expose a CLI or deep link for adding a remote host,
// so the user completes the registration in the desktop app.
func openSandboxInPaseoTarget(cmd *cobra.Command, target sandboxSSHAlias) error {
	out := cmd.OutOrStdout()
	fmt.Fprintln(out, "Make sure you have Paseo set up in your rig VM. See docs:")
	fmt.Fprintln(out)
	fmt.Fprintln(out, "https://docs.amika.dev/guides/paseo")
	fmt.Fprintln(out)
	fmt.Fprintln(out, `Open Paseo and click on "Hosts > Add host > Remote SSH" in the bottom left.`)
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Copy paste this SSH host:")
	fmt.Fprintln(out)
	fmt.Fprintf(out, "ssh://amika@%s\n", target.alias)
	return nil
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
