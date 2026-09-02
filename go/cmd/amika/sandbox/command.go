package sandboxcmd

// command.go assembles the top-level sandbox command and its flags.

import (
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/spf13/cobra"
)

const sandboxConnectWorkdir = "/home/amika"

// New builds the sandbox command tree.
func New() *cobra.Command {
	sandboxCmd := &cobra.Command{
		Use:   "sandbox",
		Short: "Manage sandboxes",
		Long:  `Create and delete sandboxed environments backed by container providers.`,
	}

	sandboxCmd.AddCommand(sandboxCreateCmd)
	sandboxCmd.AddCommand(sandboxStartCmd)
	sandboxCmd.AddCommand(sandboxStopCmd)
	sandboxCmd.AddCommand(sandboxDeleteCmd)
	sandboxCmd.AddCommand(sandboxListCmd)
	sandboxCmd.AddCommand(sandboxConnectCmd)
	// `ssh` and `code` are the direct-WebSocket-transport commands; they also
	// answer to their pre-promotion names `sshv2`/`codev2` as Cobra aliases.
	// `sshv1` and `codev1` are the provider-native predecessors they replaced,
	// registered so existing scripts keep working but marked Hidden at their
	// declarations.
	sandboxCmd.AddCommand(sandboxSSHV2Cmd)
	sandboxCmd.AddCommand(sandboxSSHV1Cmd)
	sandboxCmd.AddCommand(sandboxCodeV2Cmd)
	sandboxCmd.AddCommand(sandboxCodeV1Cmd)
	sandboxCmd.AddCommand(sandboxAgentSendCmd)

	sandboxCmd.PersistentFlags().Bool("local", false, "Only operate on local sandboxes")
	sandboxCmd.PersistentFlags().Bool("remote", false, "Only operate on remote sandboxes")
	// Contradictory flags must fail fast instead of silently resolving to one
	// mode. Cobra enforces this per leaf command (excluding ssh, which parses
	// its own flags and already rejects --local outright).
	sandboxCmd.MarkFlagsMutuallyExclusive("local", "remote")
	sandboxCmd.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
	sandboxCmd.PersistentFlags().MarkHidden("remote-target")

	addProviderFlag(sandboxCreateCmd)
	sandboxCreateCmd.Flags().String("name", "", "Name for the sandbox (auto-generated if not set)")
	sandboxCreateCmd.Flags().String("image", sandbox.DefaultCoderImage, "Docker image to use")
	sandboxCreateCmd.Flags().String("preset", "", `Use a preset environment ("coder" or "coder-dind")`)
	sandboxCreateCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rwcopy)")
	sandboxCreateCmd.Flags().StringArray("volume", nil, "Mount an existing named volume (name:target[:mode], mode defaults to rw)")
	sandboxCreateCmd.Flags().StringArray("port", nil, "Publish a container port (hostPort:containerPort[/protocol], protocol defaults to tcp)")
	sandboxCreateCmd.Flags().String("port-host-ip", "127.0.0.1", "Host IP address to bind published ports")
	sandboxCreateCmd.Flags().String("git", "", "Mount a git repo into the sandbox. Accepts a local path or a git URL (HTTPS, SSH). If omitted and the cwd is in a git repo, that repo is used automatically.")
	sandboxCreateCmd.Flags().Bool("no-git", false, "Skip git repo auto-detection; create a sandbox without mounting any repo.")
	sandboxCreateCmd.Flags().Bool("no-clean", false, "With a local-path git source, include untracked files from the working tree instead of a clean clone. Local sandboxes only.")
	sandboxCreateCmd.Flags().String("size", "", "Sandbox size, e.g. \"m\" or \"a1.medium\"; the API validates it and lists what your provider offers (default \"m\", remote only)")
	sandboxCreateCmd.Flags().String("snapshot", "", "Fork the sandbox from a captured snapshot slug (remote only)")
	sandboxCreateCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	sandboxCreateCmd.Flags().StringArray("secret", nil, "Inject a remote secret (env:FOO=SECRET_NAME or env:SECRET_NAME)")
	sandboxCreateCmd.Flags().StringArray("agent-credential", nil, "Pin an agent credential by name (KIND=NAME, e.g. claude=personal-oauth). Repeatable per kind.")
	sandboxCreateCmd.Flags().StringArray("agent-credential-type", nil, "Pin an agent credential by type (KIND=TYPE, type is oauth or api-key). Repeatable per kind.")
	sandboxCreateCmd.Flags().StringArray("no-agent-credential", nil, "Skip injecting any credential of this kind (e.g. --no-agent-credential codex). Repeatable per kind.")
	sandboxCreateCmd.Flags().Bool("yes", false, "Skip mount confirmation prompt")
	sandboxCreateCmd.Flags().Bool("connect", false, "Connect to the sandbox shell immediately after creation")
	sandboxCreateCmd.Flags().String("setup-script", "", "Mount a local script file to /usr/local/etc/amikad/setup/setup.sh in the container (read-only)")
	sandboxCreateCmd.Flags().Bool("no-setup", false, "Skip the setup script (uses a no-op script instead)")
	sandboxCreateCmd.Flags().String("branch", "", "Check out this git branch, or create it if it doesn't exist.")
	sandboxCreateCmd.Flags().String("new-branch", "", "Create a new git branch. With --branch, starts from that branch; otherwise starts from the current checkout.")
	sandboxCreateCmd.Flags().String("github-auth-mode", "", "GitHub auth mode for the sandbox runtime: pat, app_token, or app-token (remote only; unset uses server default)")
	sandboxListCmd.Flags().BoolP("long", "l", false, "Show additional columns (ID, LOCATION, BASE_SNAPSHOT, PORTS, CREATED)")
	sandboxDeleteCmd.Flags().Bool("force", false, "Skip confirmation prompt")
	sandboxDeleteCmd.Flags().Bool("delete-volumes", false, "Also delete associated volumes that are no longer referenced")
	sandboxDeleteCmd.Flags().Bool("keep-volumes", false, "Keep associated volumes even when only this sandbox references them")
	sandboxConnectCmd.Flags().String("shell", "zsh", "Shell to run in the sandbox container")
	sandboxSSHV1Cmd.Flags().BoolP("t", "t", false, "Force pseudo-terminal allocation (like ssh -t)")
	sandboxSSHV1Cmd.Flags().Bool("revoke", false, "Revoke SSH access for the sandbox")
	sandboxSSHV1Cmd.Flags().Bool("print", false, "Print the SSH connection string instead of connecting")
	// `ssh` registers no flags of its own: it forwards everything after the
	// subcommand to ssh, so ssh's own -t (and every other option) passes
	// through untouched.
	sandboxCodeV2Cmd.Flags().String("editor", "cursor", "Editor or agent to open: \"cursor\", \"vscode\", \"claude\", or \"codex\"")
	sandboxCodeV2Cmd.Flags().String("path", "", "Override the remote path to open (absolute, or relative to the sandbox workspace root)")
	sandboxCodeV1Cmd.Flags().String("editor", "cursor", "Editor or agent to open: \"cursor\", \"vscode\", \"claude\", or \"codex\"")
	sandboxCodeV1Cmd.Flags().String("path", "", "Override the remote path to open (absolute, or relative to the sandbox workspace root)")
	sandboxAgentSendCmd.Flags().Bool("no-wait", false, "Send the instruction and return immediately without waiting for a response")
	sandboxAgentSendCmd.Flags().String("workdir", "$AMIKA_AGENT_CWD", "Working directory inside the container (default: $AMIKA_AGENT_CWD)")
	sandboxAgentSendCmd.Flags().String("agent", "claude", "Agent CLI to use (default \"claude\")")
	sandboxAgentSendCmd.Flags().String("session-id", "", "Resume an existing agent session by ID (remote sandboxes only)")
	sandboxAgentSendCmd.Flags().Bool("new-session", false, "Start a new agent session (remote sandboxes only)")

	return sandboxCmd
}

func addProviderFlag(command *cobra.Command) {
	command.Flags().String("provider", "", "Sandbox provider")
	// Provider selection is an internal/testing override for remote sandboxes.
	// Normal users should let the control plane choose its configured default.
	command.Flags().MarkHidden("provider")
}
