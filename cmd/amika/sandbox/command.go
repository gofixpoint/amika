// Package sandboxcmd builds the amika sandbox command tree.
package sandboxcmd

import (
	"github.com/gofixpoint/amika/internal/sandbox"
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
	sandboxCmd.AddCommand(sandboxSSHCmd)
	sandboxCmd.AddCommand(sandboxCodeCmd)
	sandboxCmd.AddCommand(sandboxAgentSendCmd)

	sandboxCmd.PersistentFlags().Bool("local", false, "Only operate on local sandboxes")
	sandboxCmd.PersistentFlags().Bool("remote", false, "Only operate on remote sandboxes")
	sandboxCmd.PersistentFlags().String("remote-target", "", "Operate on a specific named remote target")
	sandboxCmd.PersistentFlags().MarkHidden("remote-target")

	sandboxCreateCmd.Flags().String("provider", "docker", "Sandbox provider")
	sandboxCreateCmd.Flags().String("name", "", "Name for the sandbox (auto-generated if not set)")
	sandboxCreateCmd.Flags().String("image", sandbox.DefaultCoderImage, "Docker image to use")
	sandboxCreateCmd.Flags().String("preset", "", `Use a preset environment ("coder" or "coder-dind")`)
	sandboxCreateCmd.Flags().StringArray("mount", nil, "Mount a host directory (source:target[:mode], mode defaults to rwcopy)")
	sandboxCreateCmd.Flags().StringArray("volume", nil, "Mount an existing named volume (name:target[:mode], mode defaults to rw)")
	sandboxCreateCmd.Flags().StringArray("port", nil, "Publish a container port (hostPort:containerPort[/protocol], protocol defaults to tcp)")
	sandboxCreateCmd.Flags().String("port-host-ip", "127.0.0.1", "Host IP address to bind published ports")
	sandboxCreateCmd.Flags().String("git", "", "Mount the current git repo root (or repo containing PATH) into /home/amika/workspace/{repo}")
	sandboxCreateCmd.Flags().Lookup("git").NoOptDefVal = "."
	sandboxCreateCmd.Flags().Bool("no-clean", false, "With --git, include untracked files from working tree instead of a clean clone")
	sandboxCreateCmd.Flags().String("size", "", "Sandbox size: \"xs\" or \"m\" (default \"m\", remote only)")
	sandboxCreateCmd.Flags().StringArray("env", nil, "Set environment variable (KEY=VALUE)")
	sandboxCreateCmd.Flags().StringArray("secret", nil, "Inject a remote secret (env:FOO=SECRET_NAME or env:SECRET_NAME)")
	sandboxCreateCmd.Flags().Bool("yes", false, "Skip mount confirmation prompt")
	sandboxCreateCmd.Flags().Bool("connect", false, "Connect to the sandbox shell immediately after creation")
	sandboxCreateCmd.Flags().String("setup-script", "", "Mount a local script file to /usr/local/etc/amikad/setup/setup.sh in the container (read-only)")
	sandboxCreateCmd.Flags().Bool("no-setup", false, "Skip the setup script (uses a no-op script instead)")
	sandboxCreateCmd.Flags().String("branch", "", "Check out this git branch, or create it if it doesn't exist.")
	sandboxCreateCmd.Flags().String("new-branch", "", "Create a new git branch. With --branch, starts from that branch; otherwise starts from the current checkout.")
	sandboxDeleteCmd.Flags().Bool("force", false, "Skip confirmation prompt")
	sandboxDeleteCmd.Flags().Bool("delete-volumes", false, "Also delete associated volumes that are no longer referenced")
	sandboxDeleteCmd.Flags().Bool("keep-volumes", false, "Keep associated volumes even when only this sandbox references them")
	sandboxConnectCmd.Flags().String("shell", "zsh", "Shell to run in the sandbox container")
	sandboxSSHCmd.Flags().BoolP("t", "t", false, "Force pseudo-terminal allocation (like ssh -t)")
	sandboxSSHCmd.Flags().Bool("revoke", false, "Revoke SSH access for the sandbox")
	sandboxCodeCmd.Flags().String("editor", "cursor", "Editor to open (currently only \"cursor\" is supported)")
	sandboxAgentSendCmd.Flags().Bool("no-wait", false, "Send the instruction and return immediately without waiting for a response")
	sandboxAgentSendCmd.Flags().String("workdir", "$AMIKA_AGENT_CWD", "Working directory inside the container (default: $AMIKA_AGENT_CWD)")
	sandboxAgentSendCmd.Flags().String("agent", "claude", "Agent CLI to use (default \"claude\")")
	sandboxAgentSendCmd.Flags().String("session-id", "", "Resume an existing agent session by ID (remote sandboxes only)")
	sandboxAgentSendCmd.Flags().Bool("new-session", false, "Start a new agent session (remote sandboxes only)")

	return sandboxCmd
}
