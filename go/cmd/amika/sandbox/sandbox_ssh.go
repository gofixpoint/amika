package sandboxcmd

// sandbox_ssh.go implements sandbox SSH and editor connection commands.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path"
	"runtime"
	"slices"
	"strings"
	"time"

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
	case "cursor", "vscode", "claude", "codex", "paseo", "herdr":
		return nil
	default:
		return fmt.Errorf("unsupported app %q; supported apps are %q", editor, supportedEditors)
	}
}

var supportedEditors = []string{"cursor", "vscode", "claude", "codex", "paseo", "herdr"}

// maintainSSHHosts keeps maintenance failures from preventing an editor launch.
func maintainSSHHosts(cmd *cobra.Command, paths basedir.Paths, client *apiclient.Client, alias string) {
	if _, err := ssh.CollectGarbage(paths, client, ssh.GCOptions{KeepAlias: alias}); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not clean up SSH config: %v\n", err)
	}
}

// sandboxSSHAlias is the stable Amika-managed SSH alias for a sandbox plus the
// identity needed to label and locate it, shared by every editor `sandbox open` opens.
// bareMetal marks a rig on a bare-metal host, which has no /home/amika
// workspace to open. agentCWD is the API's agent_cwd, and sshUser the login
// account the SSH session reported; either is empty when unknown.
type sandboxSSHAlias struct {
	alias       string
	sandboxName string
	repoName    string
	bareMetal   bool
	agentCWD    string
	sshUser     string
}

// remotePath is the remote folder an editor opens for this target, or "" for
// a bare-metal rig given no absolute --path: such a rig logs in as the host's
// own account, whose home directory the CLI cannot know, so the editor
// connects without opening a folder rather than guess one.
func (t sandboxSSHAlias) remotePath(pathOverride string) string {
	if t.bareMetal {
		if path.IsAbs(pathOverride) {
			return pathOverride
		}
		return ""
	}
	return resolveRemoteWorkspacePath(t.agentCWD, t.repoName, pathOverride)
}

// validateBareMetalPath rejects a relative --path for a bare-metal rig, where
// there is no known directory to resolve it against.
func validateBareMetalPath(target sandboxSSHAlias, pathOverride string) error {
	if target.bareMetal && pathOverride != "" && !path.IsAbs(pathOverride) {
		return fmt.Errorf("--path %q must be absolute for bare-metal rig %q", pathOverride, target.sandboxName)
	}
	return nil
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
	case "herdr":
		return openSandboxInHerdrTarget(cmd, target, pathOverride)
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

	args := []string{"--remote", "ssh-remote+" + target.alias}
	if remotePath := target.remotePath(pathOverride); remotePath != "" {
		args = append(args, remotePath)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Opening rig %q in %s via SSH (%s)...\n", target.sandboxName, name, target.alias)
	fmt.Fprintf(cmd.OutOrStdout(), "Running: %s %s\n", cli, strings.Join(args, " "))
	fmt.Fprintf(cmd.OutOrStdout(), "Hint: if the file explorer is not visible, press Cmd+Shift+E in %s to open it.\n", name)
	if err := launch(args...); err != nil {
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
		StartDirectory: target.remotePath(pathOverride),
	}
	if _, err := appcfg.UpsertClaudeSSHConfig(paths, host); err != nil {
		return fmt.Errorf("write Claude settings: %w", err)
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "Registered SSH environment %q for rig %q in Claude Desktop.\n", host.Name, target.sandboxName)
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
	fmt.Fprintf(out, "Enabled Codex remote connections; SSH host %q for rig %q is available from ~/.ssh/config.\n", target.alias, target.sandboxName)
	if err := openApp("codex://"); err != nil {
		fmt.Fprintf(out, "Could not launch Codex automatically (%v); open it yourself.\n", err)
	} else {
		fmt.Fprintf(out, "Opening Codex...\n")
	}
	if remotePath := target.remotePath(pathOverride); remotePath != "" {
		fmt.Fprintf(out, "In Codex, open Settings > Connections, enable host %q, and choose a remote folder (e.g. %s).\n",
			target.alias, remotePath)
	} else {
		fmt.Fprintf(out, "In Codex, open Settings > Connections, enable host %q, and choose a remote folder.\n", target.alias)
	}
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
	// A bare-metal rig's login account is the host's own, which the managed
	// SSH config already names for this alias, so the URL leaves it out.
	// Any other rig names the account its SSH session reported: amika on a
	// rig built from Amika's images, the provider's own on one that is not.
	if target.bareMetal {
		fmt.Fprintf(out, "ssh://%s\n", target.alias)
	} else {
		fmt.Fprintf(out, "ssh://%s@%s\n", target.loginUser(), target.alias)
	}
	return nil
}

// loginUser is the account the rig's SSH session logs in as, or
// apiclient.DefaultSSHUser when the session did not say.
func (t sandboxSSHAlias) loginUser() string {
	if t.sshUser != "" {
		return t.sshUser
	}
	return apiclient.DefaultSSHUser
}

// herdrMachine is a machine Herdr has saved, as amika reads it from either
// Herdr CLI: name is what Herdr calls it, and the remove hint names it by ref.
type herdrMachine struct {
	name   string
	ref    string
	target string
}

// herdrCLI is one of the two command-line tools that can add a machine to
// Herdr. They take the same SSH target but differ in binary, flags, and the
// shape of their machine list.
type herdrCLI struct {
	bin       string
	nameFlag  string
	listArgs  []string
	removeCmd string
	parse     func([]byte) ([]herdrMachine, error)
}

// herdrCLIs lists the Herdr CLIs in order of preference. The Herdr app from
// herdr.dev installs `hc` (herdr-core), which names a machine with --name and
// renames a taken name rather than refusing it. The original Herdr TUI
// installs `herdr`, which labels a machine with --label.
var herdrCLIs = []herdrCLI{
	{
		bin:       "hc",
		nameFlag:  "--name",
		listArgs:  []string{"machine", "ls", "--json"},
		removeCmd: "hc machine rm",
		parse:     parseHCMachines,
	},
	{
		bin:       "herdr",
		nameFlag:  "--label",
		listArgs:  []string{"machine", "list", "--json"},
		removeCmd: "herdr machine remove",
		parse:     parseLegacyHerdrMachines,
	},
}

// openSandboxInHerdrTarget registers a prepared SSH target as a Herdr machine,
// named after the sandbox, then opens a terminal on it in the Herdr app.
// Herdr dials the alias through the system OpenSSH config, so it reaches the
// sandbox over the managed ProxyCommand. A sandbox Herdr already has is not
// added again, and a name already held by another host is an error: the TUI
// refuses it, and hc would quietly add the sandbox under a numbered name the
// user did not ask for.
func openSandboxInHerdrTarget(cmd *cobra.Command, target sandboxSSHAlias, pathOverride string) error {
	cli, ok := findHerdrCLI()
	if !ok {
		return fmt.Errorf("herdr CLI (hc or herdr) is not installed or not in PATH; install it from https://herdr.dev")
	}
	out := cmd.OutOrStdout()
	machine, err := addHerdrMachine(cmd, cli, target)
	if err != nil {
		return err
	}
	if cli.bin != "hc" {
		// The TUI has no window to open a terminal in from here.
		if pathOverride != "" {
			fmt.Fprintf(cmd.ErrOrStderr(), "Warning: --path has no effect with the Herdr TUI\n")
		}
		return nil
	}
	if err := openHerdrSpace(machine, target.sandboxName, target.remotePath(pathOverride)); err != nil {
		fmt.Fprintf(out, "Could not open a terminal in Herdr automatically (%v); open Herdr and pick machine %q.\n", err, machine)
		return nil
	}
	fmt.Fprintf(out, "Opened a terminal on rig %q in Herdr.\n", target.sandboxName)
	return nil
}

// addHerdrMachine makes sure Herdr has the sandbox as a machine and returns
// the machine's name.
func addHerdrMachine(cmd *cobra.Command, cli herdrCLI, target sandboxSSHAlias) (string, error) {
	out := cmd.OutOrStdout()
	machines, err := cli.listMachines()
	if err != nil {
		// Listing only spares a rerun a duplicate; without it, `machine add`
		// still runs and reports what it does.
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not list Herdr machines: %v\n", err)
	}
	if i := slices.IndexFunc(machines, func(m herdrMachine) bool { return m.target == target.alias }); i >= 0 {
		fmt.Fprintf(out, "Rig %q is already a Herdr machine named %q.\n", target.sandboxName, machines[i].name)
		return machines[i].name, nil
	}
	if i := slices.IndexFunc(machines, func(m herdrMachine) bool { return m.name == target.sandboxName }); i >= 0 {
		return "", fmt.Errorf("a Herdr machine named %q already exists for a different SSH host (%s); remove it with \"%s %s\" and retry",
			target.sandboxName, machines[i].target, cli.removeCmd, machines[i].ref)
	}

	fmt.Fprintf(out, "Adding rig %q to Herdr as a machine via SSH (%s)...\n", target.sandboxName, target.alias)
	fmt.Fprintf(out, "Running: %s machine add %s %s %s\n", cli.bin, target.alias, cli.nameFlag, target.sandboxName)
	add := exec.Command(cli.bin, "machine", "add", target.alias, cli.nameFlag, target.sandboxName)
	// `machine add` may prompt, e.g. to copy hc to the sandbox or to pick a
	// remote session.
	add.Stdin = cmd.InOrStdin()
	add.Stdout = out
	add.Stderr = cmd.ErrOrStderr()
	if err := add.Run(); err != nil {
		return "", fmt.Errorf("%s machine add failed: %w", cli.bin, err)
	}
	return target.sandboxName, nil
}

// herdrAppReadyTimeout bounds each wait on the Herdr window: for one amika
// started to open, and for it to know a machine amika just added.
var herdrAppReadyTimeout = 20 * time.Second

// openHerdrSpace opens a new Herdr space on machine: a focused terminal in
// folder (the machine's home when empty). `herdr-app do` talks to a running
// window, so Herdr is started first when none is open.
func openHerdrSpace(machine, name, folder string) error {
	if _, err := exec.LookPath("herdr-app"); err != nil {
		return fmt.Errorf("herdr-app is not in PATH")
	}
	if !herdrAppRunning() {
		if err := launchHerdrApp(); err != nil {
			return fmt.Errorf("start Herdr: %w", err)
		}
		deadline := time.Now().Add(herdrAppReadyTimeout)
		for !herdrAppRunning() {
			if time.Now().After(deadline) {
				return fmt.Errorf("no Herdr window answered within %s", herdrAppReadyTimeout)
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	space := map[string]string{"machine": machine, "name": name}
	if folder != "" {
		space["folder"] = folder
	}
	// One JSON object rather than --key value pairs: herdr-app reads a value
	// that parses as JSON as JSON, so a rig named "123" would become a number.
	args, err := json.Marshal(space)
	if err != nil {
		return err
	}
	// The window learns of a machine from its own poll of the core, every few
	// seconds, and then has to connect to it, so a machine added a moment ago
	// is "no machine called ..." at first. Retry until the window has it.
	deadline := time.Now().Add(herdrAppReadyTimeout)
	for {
		output, err := exec.Command("herdr-app", "do", "space.new", string(args)).CombinedOutput()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("herdr-app do space.new: %w: %s", err, strings.TrimSpace(string(output)))
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// herdrAppRunning reports whether a Herdr window answers on its control
// socket; `herdr-app status` fails when none is open.
func herdrAppRunning() bool {
	return exec.Command("herdr-app", "status").Run() == nil
}

// launchHerdrApp starts the Herdr app without waiting for it. A bare
// `herdr-app` opens the window, or raises one already open. A var so tests
// can stand in for it.
var launchHerdrApp = func() error {
	var c *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		// Through LaunchServices, so Herdr runs as an app, not as a child of
		// this terminal.
		c = exec.Command("open", "-a", "Herdr")
	case "linux":
		// In its own session, so closing this terminal does not close Herdr.
		c = exec.Command("setsid", "-f", "herdr-app")
	case "windows":
		c = exec.Command("cmd", "/c", "start", "", "herdr-app")
	default:
		return fmt.Errorf("unsupported platform %q", runtime.GOOS)
	}
	return c.Run()
}

// findHerdrCLI returns the first Herdr CLI on PATH.
func findHerdrCLI() (herdrCLI, bool) {
	for _, cli := range herdrCLIs {
		if _, err := exec.LookPath(cli.bin); err == nil {
			return cli, true
		}
	}
	return herdrCLI{}, false
}

// listMachines returns the SSH machines Herdr has saved.
func (c herdrCLI) listMachines() ([]herdrMachine, error) {
	data, err := exec.Command(c.bin, c.listArgs...).Output()
	if err != nil {
		return nil, err
	}
	machines, err := c.parse(data)
	if err != nil {
		return nil, fmt.Errorf("parse %s machine list: %w", c.bin, err)
	}
	return machines, nil
}

// parseHCMachines reads `hc machine ls --json`: {"machines": [...]}, each
// removed by its name.
func parseHCMachines(data []byte) ([]herdrMachine, error) {
	var list struct {
		Machines []struct {
			Name   string `json:"name"`
			Target string `json:"target"`
		} `json:"machines"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	machines := make([]herdrMachine, 0, len(list.Machines))
	for _, m := range list.Machines {
		machines = append(machines, herdrMachine{name: m.Name, ref: m.Name, target: m.Target})
	}
	return machines, nil
}

// parseLegacyHerdrMachines reads the Herdr TUI's `herdr machine list --json`:
// a bare array, each removed by its id.
func parseLegacyHerdrMachines(data []byte) ([]herdrMachine, error) {
	var list []struct {
		ID     string `json:"id"`
		Label  string `json:"label"`
		Target string `json:"target"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	machines := make([]herdrMachine, 0, len(list))
	for _, m := range list {
		machines = append(machines, herdrMachine{name: m.Label, ref: m.ID, target: m.Target})
	}
	return machines, nil
}

// resolveRemoteWorkspacePath computes the remote path to open in the editor.
// agentCWD is the API's agent_cwd: the directory agents run in, which the
// server builds as <home>/workspace[/<repo>] from the provider's own home
// directory. An absolute pathOverride is used verbatim; a relative one is
// joined onto the rig's home, so that e.g. "workspace/biz" →
// "<home>/workspace/biz". With no pathOverride, agentCWD is used.
//
// A control plane that does not report agent_cwd sends none, and the rig is
// then taken to be one built from Amika's images: home /home/amika, and the
// workspace path extended with the repo name.
func resolveRemoteWorkspacePath(agentCWD, repoName, pathOverride string) string {
	home := rigHomeDir(agentCWD, repoName)
	if pathOverride != "" {
		if path.IsAbs(pathOverride) {
			return pathOverride
		}
		return path.Join(home, pathOverride)
	}
	if path.IsAbs(agentCWD) {
		return agentCWD
	}
	remotePath := path.Join(home, "workspace")
	if repoName != "" {
		remotePath = remotePath + "/" + repoName
	}
	return remotePath
}

// defaultRigHome is the login account's home on a rig built from Amika's
// images. A provider's own image can put it elsewhere (InstaBox uses
// /data/home), which agent_cwd reports.
const defaultRigHome = "/home/amika"

// rigHomeDir derives the rig's home from agentCWD, which the server builds as
// <home>/workspace or <home>/workspace/<repo> (getRepoDir in @amika/sandbox).
// The repo is absent when the rig has none, or when cloning it failed. It
// returns defaultRigHome when agentCWD is empty or has another shape.
func rigHomeDir(agentCWD, repoName string) string {
	if !path.IsAbs(agentCWD) {
		return defaultRigHome
	}
	dir := path.Clean(agentCWD)
	suffixes := []string{"/workspace"}
	if repoName != "" {
		suffixes = append([]string{"/workspace/" + repoName}, suffixes...)
	}
	for _, suffix := range suffixes {
		if home, ok := strings.CutSuffix(dir, suffix); ok {
			if home == "" {
				return "/"
			}
			return home
		}
	}
	return defaultRigHome
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
