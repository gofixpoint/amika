package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/sessioncapture"
	"github.com/spf13/cobra"
)

var sessionsCmd = &cobra.Command{
	Use:    "sessions",
	Hidden: true,
	Short:  "Manage local agent session capture",
	Long: `Capture sessions from local AI coding agents (Claude Code, Codex) into
the amika state directory by installing per-agent hooks.

Run "amika sessions capture-init" once to register the hooks. From then on,
each agent will invoke "amika sessions capture" itself whenever it finishes
a turn; no daemon is involved.`,
}

var sessionsCaptureInitCmd = &cobra.Command{
	Use:   "capture-init",
	Short: "Register session-capture hooks with Claude and Codex",
	Long: `Install hooks into the local Claude Code and Codex configurations so that
each agent mirrors its session transcripts into the amika state directory
whenever it finishes a turn.

Writes to:
  ~/.claude/settings.json   (adds a Stop hook)
  ~/.codex/config.toml      (sets the notify program)

Captured transcripts land under:
  $AMIKA_STATE_DIRECTORY/raw-sessions/{claude,codex}/
(default $AMIKA_STATE_DIRECTORY is ~/.local/state/amika).

Each transcript gets a sibling <session>.meta.json sidecar recording, per
turn, the git commit/branch the work happened on and the tool calls that
turn made.

The exact destination directories are printed when the command runs.

This command is idempotent.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolving home directory: %w", err)
		}
		hookCmd, err := sessioncapture.DefaultHookCommand()
		if err != nil {
			return err
		}
		rep, err := sessioncapture.Init(home, hookCmd)
		if err != nil {
			return err
		}
		stateDir, err := config.StateDir()
		if err != nil {
			return fmt.Errorf("resolving state directory: %w", err)
		}
		out := cmd.OutOrStdout()
		if rep.ClaudeUpdated {
			fmt.Fprintf(out, "Added Stop hook to %s\n", rep.ClaudeSettingsPath)
		} else {
			fmt.Fprintf(out, "Stop hook already present in %s\n", rep.ClaudeSettingsPath)
		}
		switch {
		case rep.CodexConflict != "":
			fmt.Fprintf(os.Stderr,
				"Skipped %s: existing notify = %s does not look like amika; leaving it alone\n",
				rep.CodexConfigPath, rep.CodexConflict)
		case rep.CodexUpdated:
			fmt.Fprintf(out, "Set notify program in %s\n", rep.CodexConfigPath)
		default:
			fmt.Fprintf(out, "Notify program already set in %s\n", rep.CodexConfigPath)
		}
		fmt.Fprintln(out, "Captures will be written to:")
		fmt.Fprintf(out, "  claude: %s\n", sessioncapture.CaptureDir(stateDir, sessioncapture.SourceClaude))
		fmt.Fprintf(out, "  codex:  %s\n", sessioncapture.CaptureDir(stateDir, sessioncapture.SourceCodex))
		return nil
	},
}

var sessionsCaptureCmd = &cobra.Command{
	Use:   "capture",
	Short: "Mirror the current agent session into the amika state directory",
	Long: `Mirror the session transcript currently being written by Claude Code or
Codex into the amika state directory.

This is intended to be invoked by the agent's own hook system (see
"amika sessions capture-init"), not by hand. The --source flag selects
which agent's session to capture; the Claude variant reads the hook
payload from stdin to learn the transcript path, while Codex's notify
hook appends a JSON event payload as a positional argument that we
accept and ignore.`,
	// Codex's notify hook invokes the configured argv with one trailing
	// JSON payload, e.g. '{"type":"agent-turn-complete",...}'. We accept
	// 0 or 1 positional so that path doesn't fail at arg validation; the
	// payload itself isn't needed for the mirror (we resolve the active
	// session by mtime).
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, _ []string) error {
		source, _ := cmd.Flags().GetString("source")
		stateDir, err := config.StateDir()
		if err != nil {
			return fmt.Errorf("resolving state directory: %w", err)
		}
		switch sessioncapture.Source(source) {
		case sessioncapture.SourceClaude:
			return sessioncapture.CaptureClaude(cmd.InOrStdin(), stateDir)
		case sessioncapture.SourceCodex:
			home, err := os.UserHomeDir()
			if err != nil {
				return fmt.Errorf("resolving home directory: %w", err)
			}
			return sessioncapture.CaptureCodex(home, stateDir)
		default:
			return fmt.Errorf("unknown --source %q (want claude or codex)", source)
		}
	},
}

func init() {
	rootCmd.AddCommand(sessionsCmd)
	sessionsCmd.AddCommand(sessionsCaptureInitCmd)
	sessionsCmd.AddCommand(sessionsCaptureCmd)
	sessionsCaptureCmd.Flags().String("source", "", "Source agent (claude|codex)")
	_ = sessionsCaptureCmd.MarkFlagRequired("source")
}
