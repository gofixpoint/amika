package sandboxcmd

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/cliargs"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// osArgs is a seam over the process argv, which the positional split needs to
// tell an amika flag written before "ssh" from an ssh option written after it.
// Tests supply a synthetic argv instead of mutating the real one.
var osArgs = func() []string { return os.Args }

// execSessionSSH is a seam around the exec of the system ssh binary, so tests
// can assert the argv the command would run without replacing the process.
var execSessionSSH = ssh.ExecSessionSSH

// newSSHV2Client is a seam over the API client `sandbox ssh` resolves a sandbox
// through, narrowed to the two calls the command makes so tests can supply a
// stub instead of reaching the network.
var newSSHV2Client = func(target string) (sshV2Client, error) {
	return getRemoteClient(target)
}

// sshV2OwnValueFlags are the amika flags reaching `sandbox ssh` that take their
// value as a separate token. commandIndex skips those values so a sandbox named
// for the subcommand ("--remote-target ssh") is not read as the subcommand.
var sshV2OwnValueFlags = map[string]bool{
	"--output":        true,
	"-o":              true,
	"--remote-target": true,
}

var sandboxSSHV2Cmd = &cobra.Command{
	Use:   "ssh [ssh-options] <name> [command...]",
	Short: "SSH into a remote sandbox",
	Long: `Open an SSH session to a remote sandbox over Amika's direct WebSocket
transport. Requires an SSH identity from "amika secret ssh-keygen".

Use it like ssh: options go before the sandbox name, an optional command
after it. Every ssh option works, including port forwarding.

Amika's own flags go before "ssh":

  amika sandbox --remote ssh -N -L 8080:localhost:80 my-sandbox

Local (-L) and dynamic (-D) forwarding are supported. Remote forwarding (-R),
agent forwarding (-A), and X11 forwarding are not.

Examples:
  # Interactive shell
  amika sandbox ssh my-sandbox

  # Run a command instead of opening a shell
  amika sandbox ssh my-sandbox uptime

  # Forward local port 6789 to port 3010 inside the sandbox, no shell
  amika sandbox ssh -N -L 6789:localhost:3010 my-sandbox

  # SOCKS proxy on local port 1080
  amika sandbox ssh -N -D 1080 my-sandbox`,
	// Arguments after "ssh" belong to ssh, so Cobra must not parse them: it
	// would reject "-L" and friends as unknown flags. RunE therefore parses the
	// amika-owned portion itself, after splitting the two apart by position.
	DisableFlagParsing: true,
	// The usage line already spells out where options go, and the trailing
	// "[flags]" Cobra appends would suggest amika flags belong after the
	// subcommand, which is exactly what they must not do.
	DisableFlagsInUseLine: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		own, forward := cliargs.Split(osArgs(), args, cmd.Name(), sshV2OwnValueFlags)
		// DisableFlagParsing bypasses Cobra's built-in help flag, so honor it
		// here before anything else can fail on an incomplete command line.
		if cliargs.HasHelpFlag(forward) || cliargs.HasHelpFlag(own) {
			return cmd.Help()
		}
		// Cobra merges the parents' persistent flags into a command's own set
		// inside ParseFlags, which DisableFlagParsing skips. Reading
		// InheritedFlags forces that merge, so --local, --remote,
		// --remote-target, and --output resolve as they do elsewhere.
		_ = cmd.InheritedFlags()
		if err := cmd.Flags().Parse(own); err != nil {
			return err
		}
		if err := output.RejectFlag(cmd); err != nil {
			return err
		}
		if runmode.Resolve(cmd) == runmode.Local {
			return fmt.Errorf("direct WebSocket SSH requires a remote sandbox")
		}
		// Locate the sandbox name before requiring auth, so an unusable command
		// line is reported as the usage error it is rather than as a login
		// prompt.
		nameIdx := cliargs.FirstOperand(forward, cliargs.SSHArgLetters)
		if nameIdx < 0 {
			return fmt.Errorf("missing sandbox name; usage: amika sandbox ssh [ssh-options] <name> [command...]")
		}
		if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
			return err
		}
		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}
		client, err := newSSHV2Client(target)
		if err != nil {
			return err
		}
		sandbox, err := client.GetSandbox(forward[nameIdx])
		if err != nil {
			return err
		}
		alias, err := prepareSessionTarget(
			basedir.New(""),
			client,
			sandbox.Name,
			sandbox.ID,
		)
		if err != nil {
			return err
		}
		return execSessionSSH(alias, ssh.BuildSessionSSHArgv(forward, nameIdx, alias))
	},
}

var sandboxCodeV2Cmd = &cobra.Command{
	Use:   "code <name>",
	Short: "Open a remote sandbox in an editor or agent via SSH",
	Long: `Open a remote sandbox in an editor or coding agent over Amika's direct
WebSocket SSH transport, bypassing provider-native SSH access.

Supported --editor values:
  cursor   launch Cursor connected to the sandbox (default)
  vscode   launch VS Code connected to the sandbox
  claude   register the sandbox as a Claude Desktop SSH environment
  codex    expose the sandbox to Codex as an SSH connection

The command creates a managed SSH alias backed by Amika's WebSocket proxy, then
hands that alias to the selected editor. It requires an SSH identity from
"amika secret ssh-keygen".

Examples:
  amika sandbox code my-sandbox
  amika sandbox code my-sandbox --editor=cursor
  amika sandbox code my-sandbox --editor=vscode
  amika sandbox code my-sandbox --editor=claude
  amika sandbox code my-sandbox --editor=codex`,
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

// sshV2Client is the subset of apiclient.Client `sandbox code` needs to prepare
// a direct-session SSH alias for an editor.
type sshV2Client interface {
	ssh.SessionCreator
	GetSandbox(name string) (*apiclient.RemoteSandbox, error)
}

// prepareSessionTarget is a seam around the shared session-transport setup used
// by `sandbox code`, `sandbox ssh`, and `scp`. Keeping it replaceable lets the
// command package verify its alias handoff without re-testing the session
// package's key and pinning logic.
var prepareSessionTarget = ssh.PrepareSessionTarget

// upsertSessionHost makes a concrete session alias discoverable to editors that
// enumerate SSH Host entries, notably Codex. Cursor and Claude receive their
// aliases directly, so this extra persistent entry is specific to `sandbox code`.
var upsertSessionHost = ssh.UpsertSessionHost

// resolveSandboxV2SSHAlias prepares the same direct-session alias used by
// `sandbox ssh` and `scp`. Editors subsequently use system OpenSSH, which
// invokes the managed alias's ProxyCommand once it dials the host.
func resolveSandboxV2SSHAlias(client sshV2Client, paths basedir.Paths, name string) (sandboxSSHAlias, error) {
	sandbox, err := client.GetSandbox(name)
	if err != nil {
		return sandboxSSHAlias{}, err
	}
	alias, err := prepareSessionTarget(paths, client, sandbox.Name, sandbox.ID)
	if err != nil {
		return sandboxSSHAlias{}, err
	}
	if err := upsertSessionHost(paths, alias); err != nil {
		return sandboxSSHAlias{}, fmt.Errorf("write direct SSH host alias: %w", err)
	}
	repoName := ""
	if sandbox.RepoName != nil {
		repoName = *sandbox.RepoName
	}
	return sandboxSSHAlias{alias: alias, sandboxName: sandbox.Name, repoName: repoName}, nil
}
