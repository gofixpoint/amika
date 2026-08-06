package main

// send.go implements the top-level `send` command and the `sessions` command
// group, which drive the remote `agent-sessions` API: send a message to a
// coding agent (creating a sandbox behind the scenes when needed) and
// list / show the resulting durable chats.

import (
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

// sendStdinPiped reports whether stdin is a pipe/redirect rather than a
// terminal, so a message can be read from it when no positional arg is given.
func sendStdinPiped() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) == 0
}

var sendCmd = &cobra.Command{
	Use:   "send [message]",
	Short: "Send a message to a coding agent, creating a sandbox if needed",
	Long: `Send a message to a coding agent via the remote agent-sessions API.

If neither --session-id nor --sandbox is given, a sandbox is created behind the
scenes and a new chat is started; the returned session id can be passed back as
--session-id to continue the conversation. The agent (claude or codex) comes
from --agent, else the organization's default, else claude.

The message can be provided as a positional argument or piped via stdin. The
command is synchronous: it blocks until the agent finishes and prints the reply.

In text output (the default) "session_id: <id>" is written to stderr first,
before the response is written to stdout, keeping stdout the pure agent
response. With --output json, a single JSON object matching the API's
AgentSessionSendResponse is written to stdout instead.`,
	Args: cobra.ArbitraryArgs,
	RunE: runSend,
}

func runSend(cmd *cobra.Command, args []string) error {
	var message string
	if len(args) > 0 {
		message = strings.Join(args, " ")
	} else if sendStdinPiped() {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("failed to read message from stdin: %w", err)
		}
		message = strings.TrimSpace(string(data))
	}
	if message == "" {
		return fmt.Errorf("message is required as an argument or via stdin")
	}

	agent, _ := cmd.Flags().GetString("agent")
	sessionID, _ := cmd.Flags().GetString("session-id")
	sandboxRef, _ := cmd.Flags().GetString("sandbox")
	newSession, _ := cmd.Flags().GetBool("new-session")
	repo, _ := cmd.Flags().GetString("repo")

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	// The agent-sessions API is remote-only: it provisions sandboxes in the
	// control plane, so there is no local equivalent.
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}

	resp, err := runmode.NewRemoteClient().SendAgentSession(apiclient.AgentSessionSendRequest{
		Message:    message,
		Agent:      agent,
		SessionID:  sessionID,
		SandboxID:  sandboxRef,
		NewSession: newSession,
		RepoURL:    repo,
	})
	if err != nil {
		return err
	}

	if format.IsJSON() {
		if err := format.JSON(cmd.OutOrStdout(), resp); err != nil {
			return err
		}
		if resp.IsError {
			return fmt.Errorf("agent returned an error")
		}
		return nil
	}

	// Text: identifying metadata goes to stderr so stdout stays the pure reply.
	if resp.SessionID != "" {
		fmt.Fprintf(os.Stderr, "session_id: %s\n", resp.SessionID)
	}
	if resp.CreatedSandbox {
		fmt.Fprintf(os.Stderr, "created sandbox: %s\n", resp.SandboxID)
	}
	fmt.Fprint(os.Stdout, resp.Response)
	if resp.Response != "" && !strings.HasSuffix(resp.Response, "\n") {
		fmt.Fprintln(os.Stdout)
	}
	if resp.IsError {
		return fmt.Errorf("agent returned an error")
	}
	return nil
}

var sessionsCmd = &cobra.Command{
	Use:     "sessions",
	Aliases: []string{"session"},
	Short:   "List and inspect agent-session chats",
	Long:    `View the durable agent-session chats created by "amika send".`,
}

var sessionsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the organization's agent-session chats",
	Args:  cobra.NoArgs,
	RunE:  runSessionsList,
}

func runSessionsList(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}
	sessions, err := runmode.NewRemoteClient().ListAgentSessions()
	if err != nil {
		return err
	}

	if format.IsJSON() {
		// Emit the API schema verbatim; a nil slice becomes `[]`, not `null`.
		if sessions == nil {
			sessions = []apiclient.AgentSessionSummary{}
		}
		return format.JSON(cmd.OutOrStdout(), sessions)
	}

	if len(sessions) == 0 {
		fmt.Fprintln(format.Progress(cmd.OutOrStdout()), "No agent-session chats yet.")
		return nil
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "SESSION ID\tAGENT\tSTATUS\tSANDBOX\tUPDATED")
	for _, s := range sessions {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			s.SessionID,
			strOrDash(s.Agent),
			s.Status,
			strOrDash(s.SandboxID),
			s.UpdatedAt,
		)
	}
	return w.Flush()
}

var sessionsShowCmd = &cobra.Command{
	Use:   "show <session-id>",
	Short: "Show an agent-session chat and its messages",
	Args:  cobra.ExactArgs(1),
	RunE:  runSessionsShow,
}

func runSessionsShow(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}
	detail, err := runmode.NewRemoteClient().GetAgentSession(args[0])
	if err != nil {
		return err
	}

	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), detail)
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "session:  %s\n", detail.SessionID)
	fmt.Fprintf(out, "agent:    %s\n", strOrDash(detail.Agent))
	fmt.Fprintf(out, "sandbox:  %s\n", strOrDash(detail.SandboxID))
	fmt.Fprintf(out, "status:   %s\n", detail.Status)
	fmt.Fprintln(out)
	for _, m := range detail.Messages {
		marker := ""
		if m.IsError {
			marker = " (error)"
		}
		fmt.Fprintf(out, "[%s] %s%s:\n%s\n\n", m.Direction, m.Author, marker, m.Contents)
	}
	return nil
}

// strOrDash renders a nullable string field as "-" when unset, so text tables
// don't print an empty cell for a chat whose sandbox has been cleaned up.
func strOrDash(s *string) string {
	if s == nil || *s == "" {
		return "-"
	}
	return *s
}

func init() {
	sendCmd.Flags().String("agent", "", "Coding agent to use: claude or codex (default: org setting, else claude)")
	sendCmd.Flags().String("session-id", "", "Continue an existing chat by its session id")
	sendCmd.Flags().String("sandbox", "", "Send into a specific sandbox (id or name)")
	sendCmd.Flags().Bool("new-session", false, "Start a brand-new chat")
	sendCmd.Flags().String("repo", "", "Repository URL to clone when a sandbox is created")
	rootCmd.AddCommand(sendCmd)

	sessionsCmd.AddCommand(sessionsListCmd)
	sessionsCmd.AddCommand(sessionsShowCmd)
	rootCmd.AddCommand(sessionsCmd)
}
