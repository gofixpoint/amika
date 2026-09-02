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
	"github.com/gofixpoint/amika/go/internal/gitrepo"
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

// stdoutIsTerminal reports whether stdout is a terminal (not a pipe/redirect).
// It drives the default streaming choice: stream to an interactive terminal
// for a live reply, but buffer when stdout is piped so a script's captured
// output stays the single final response, not the concatenated deltas.
func stdoutIsTerminal() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

var sendCmd = &cobra.Command{
	Use:   "send [message]",
	Short: "Send a message to a coding agent, creating a sandbox if needed",
	Long: `Send a message to a coding agent via the remote agent-sessions API.

If neither --session-id nor --sandbox is given, a sandbox is created behind the
scenes and a new chat is started; the returned session id can be passed back as
--session-id to continue the conversation. The agent (claude or codex) comes
from --agent, else the organization's default, else claude.

Run from inside a git repo and that repo's "origin" remote is cloned into
the sandbox, the same way "amika sandbox create" picks up the repo you are
standing in. Pass --git <path|url> to choose a different repo, or --no-git for
a sandbox with no repo at all; --repo is accepted as an alias for --git. Only
the repo's default branch is cloned, whatever branch you have checked out
locally.

Repo selection only applies to a sandbox this command creates, so it cannot be
combined with --session-id or --sandbox.

The message can be provided as a positional argument or piped via stdin.

By default the reply streams in as the agent produces it when stdout is a
terminal, and is buffered (printed once, whole) when stdout is piped or
--output json is set. Use --stream / --stream=false to force either mode; JSON
output is always buffered so the emitted object stays valid.

In text output (the default) identifying metadata ("session_id: <id>", sandbox
progress) is written to stderr, keeping stdout the pure agent response. With
--output json, a single JSON object matching the API's AgentSessionSendResponse
is written to stdout instead.`,
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

	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	// Streaming: default on for an interactive terminal, off when piped, and
	// always off for JSON (deltas can't be emitted as one valid object). An
	// explicit --stream / --stream=false overrides the default, except in JSON
	// mode which stays buffered regardless.
	stream := false
	if !format.IsJSON() {
		if cmd.Flags().Changed("stream") {
			stream = mustBool(cmd, "stream")
		} else {
			stream = stdoutIsTerminal()
		}
	}

	// Contradictory repo flags are reported before the auth gate: checking
	// them costs nothing, so a login should not stand between the caller and
	// a plain flag conflict. Only the flag-level checks move up — a bad path
	// needs the filesystem, so it still waits.
	if err := validateSendRepoFlags(cmd, sessionID, sandboxRef); err != nil {
		return err
	}

	// The agent-sessions API is remote-only: it provisions sandboxes in the
	// control plane, so there is no local equivalent.
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}

	// Resolving the repo waits until after the gate: it walks the filesystem
	// and shells out to git, and login is the precondition for all of it, so
	// someone not logged in hears that rather than a complaint about their
	// git remote.
	repoURL, repoName, err := sendRepo(cmd, sessionID, sandboxRef)
	if err != nil {
		return err
	}
	printSendRepo(format, os.Stderr, repoName)

	req := apiclient.AgentSessionSendRequest{
		Message:    message,
		Agent:      agent,
		SessionID:  sessionID,
		SandboxID:  sandboxRef,
		NewSession: newSession,
		RepoURL:    repoURL,
	}
	client := runmode.NewRemoteClient()

	if stream {
		return runSendStreaming(client, req)
	}

	resp, err := client.SendAgentSession(req)
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

// printSendRepo reports which repo the sandbox will get, on stderr alongside
// the other identifying lines so stdout stays the pure agent reply.
//
// Suppressed under --output json, per the CLI's rule that human progress goes
// through format.Progress: a JSON caller gets one object and nothing else,
// even on the stream stdout does not use.
func printSendRepo(format output.Format, w io.Writer, name string) {
	if name == "" {
		return
	}
	fmt.Fprintf(format.Progress(w), "repo: %s\n", name)
}

// validateSendRepoFlags rejects a repo selection this command cannot honor,
// using only the flags themselves so it can run before the auth gate.
//
// Beyond the contradictions gitrepo knows about, `send` has one of its own:
// --session-id and --sandbox address a sandbox that already exists, so no
// repo is created and an explicitly requested one cannot be honored. Refusing
// beats dropping it from the request, which would show up only in what the
// agent could see. --no-git needs no such refusal — it asks for exactly what
// already happens there.
func validateSendRepoFlags(cmd *cobra.Command, sessionID, sandboxRef string) error {
	if err := gitrepo.ValidateFlags(cmd); err != nil {
		return err
	}
	if sessionID == "" && sandboxRef == "" {
		return nil
	}
	if flag := gitrepo.RequestedFlag(cmd); flag != "" {
		return fmt.Errorf(
			"--%s cannot be combined with --session-id or --sandbox; it only applies to a sandbox this command creates",
			flag)
	}
	return nil
}

// sendRepo decides which git repo the sandbox created for this message should
// clone, returning the URL to send and a short name to report (empty when
// there is no repo to name).
//
// A message aimed at an existing chat (--session-id) or an existing sandbox
// (--sandbox) creates nothing, so there is no repo to choose and the working
// directory is not consulted at all.
func sendRepo(cmd *cobra.Command, sessionID, sandboxRef string) (url, name string, err error) {
	if sessionID != "" || sandboxRef != "" {
		// validateSendRepoFlags has already refused an explicit repo here, so
		// this is the "nothing was asked for" case: skip detection entirely.
		return "", "", nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", "", fmt.Errorf("failed to determine working directory: %w", err)
	}
	identity, err := gitrepo.FromCommand(cmd, cwd)
	if err != nil {
		return "", "", err
	}
	url, err = identity.RemoteURL()
	if err != nil {
		return "", "", err
	}
	// Name, not URL: it is what identifies the repo to a reader, it matches
	// what `sandbox create` reports, and an origin can carry a token in its
	// userinfo that has no business on a terminal.
	return url, identity.Name, nil
}

// mustBool reads a bool flag, ignoring the (impossible for a defined flag)
// lookup error to keep call sites terse.
func mustBool(cmd *cobra.Command, name string) bool {
	v, _ := cmd.Flags().GetBool(name)
	return v
}

// runSendStreaming drives the SSE transport for text output: sandbox lifecycle
// progress goes to stderr, the reply streams to stdout as it arrives, and the
// session id is reported on stderr once known. stdout carries only the agent's
// text, matching the buffered path.
func runSendStreaming(
	client *apiclient.Client,
	req apiclient.AgentSessionSendRequest,
) error {
	var streamed strings.Builder

	resp, err := client.SendAgentSessionStream(req, apiclient.AgentSessionStreamHandlers{
		OnStatus: func(phase, sandboxID string) {
			switch phase {
			case "creating_sandbox":
				fmt.Fprintln(os.Stderr, "creating sandbox…")
			case "sandbox_ready":
				if sandboxID != "" {
					fmt.Fprintf(os.Stderr, "sandbox ready: %s\n", sandboxID)
				}
			}
		},
		OnDelta: func(text string) {
			streamed.WriteString(text)
			fmt.Fprint(os.Stdout, text)
		},
	})
	// written tracks everything that has reached stdout, so a partial line can
	// be closed off exactly once at the end.
	written := streamed.String()
	endLine := func() {
		if written != "" && !strings.HasSuffix(written, "\n") {
			fmt.Fprintln(os.Stdout)
		}
	}
	if err != nil {
		endLine()
		return err
	}

	extra, continuation := unstreamedRemainder(written, resp.Response)
	if extra != "" {
		// A continuation resumes the streamed text mid-word, so it must not be
		// pushed onto a new line; anything else is separate output and starts
		// on its own line.
		if !continuation {
			endLine()
		}
		fmt.Fprint(os.Stdout, extra)
		written += extra
	}
	endLine()

	if resp.SessionID != "" {
		fmt.Fprintf(os.Stderr, "session_id: %s\n", resp.SessionID)
	}
	if resp.IsError {
		return fmt.Errorf("agent returned an error")
	}
	return nil
}

// unstreamedRemainder decides how much of the authoritative response still has
// to be printed once `streamed` has already gone to stdout, and whether that
// text continues the streamed run directly rather than starting fresh.
//
// The two strings come from different server-side parsers over the same agent
// output — deltas from the incremental event stream, `response` from the final
// result object — so they are not guaranteed to match. Showing only the stream
// can silently drop the authoritative result (most visibly on a failed turn,
// where `response` carries the agent CLI's own message and no delta ever does);
// always appending it would duplicate text on the common runs where they agree.
func unstreamedRemainder(streamed, response string) (extra string, continuation bool) {
	switch {
	case streamed == "":
		// An empty reply, or a provider that only yields a final result;
		// stdout would otherwise be empty for a non-empty response.
		return response, false
	case strings.HasPrefix(response, streamed):
		// The common case. A stream cut short contributes exactly its missing
		// tail; identical texts leave nothing to add, and then there is no
		// run to continue either.
		remainder := response[len(streamed):]
		return remainder, remainder != ""
	case strings.Contains(streamed, response):
		// The stream carried more than the final message (intermediate text
		// across tool calls) and already included it — appending would repeat.
		return "", false
	default:
		// Genuinely divergent: the authoritative result wins over showing only
		// the stream.
		return response, false
	}
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
	limit, _ := cmd.Flags().GetInt("limit")
	resp, err := runmode.NewRemoteClient().ListAgentSessions(limit)
	if err != nil {
		return err
	}

	if format.IsJSON() {
		// Emit the API's {sessions,total} envelope verbatim, as a remote-backed
		// command must — the same reason `snapshot list` re-emits its
		// {"items": [...]}. Dropping to a bare array here would both diverge
		// from the documented schema and discard `total`.
		return format.JSON(cmd.OutOrStdout(), resp)
	}

	sessions := resp.Sessions
	if len(sessions) == 0 {
		fmt.Fprintln(format.Progress(cmd.OutOrStdout()), "No agent-session chats yet.")
		return nil
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "SESSION ID\tAGENT\tSTATUS\tSANDBOX\tUPDATED")
	for _, s := range sessions {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			s.SessionID,
			s.Agent,
			s.Status,
			// Prefer the human-readable sandbox name, falling back to the id
			// when the sandbox has been deleted and the name can't be resolved.
			strOrDash(s.SandboxName, s.SandboxID),
			s.UpdatedAt,
		)
	}
	if err := w.Flush(); err != nil {
		return err
	}
	// Never present a page as the whole list: the server caps the page size, so
	// say what was withheld and how to see it.
	if resp.Total > len(sessions) {
		fmt.Fprintf(format.Progress(cmd.OutOrStdout()),
			"\nShowing %d of %d chats; use --limit to see more.\n",
			len(sessions), resp.Total)
	}
	return nil
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
	fmt.Fprintf(out, "agent:    %s\n", detail.Agent)
	fmt.Fprintf(out, "sandbox:  %s\n", strOrDash(detail.SandboxName, detail.SandboxID))
	fmt.Fprintf(out, "status:   %s\n", detail.Status)
	fmt.Fprintln(out)
	for _, m := range detail.Messages {
		marker := ""
		if m.IsError != nil && *m.IsError {
			marker = " (error)"
		}
		fmt.Fprintf(out, "[%s]%s %s\n%s\n\n", m.Role, marker, m.Timestamp, m.Content)
	}
	return nil
}

// strOrDash renders a nullable string field, falling back through the given
// alternatives and finally to "-", so a text table never prints an empty cell
// for a chat whose sandbox name could not be resolved.
func strOrDash(s *string, fallbacks ...string) string {
	if s != nil && *s != "" {
		return *s
	}
	for _, f := range fallbacks {
		if f != "" {
			return f
		}
	}
	return "-"
}

func init() {
	sendCmd.Flags().String("agent", "", "Coding agent to use: claude or codex (default: org setting, else claude)")
	sendCmd.Flags().String("session-id", "", "Continue an existing chat by its session id")
	sendCmd.Flags().String("sandbox", "", "Send into a specific sandbox (id or name)")
	sendCmd.Flags().Bool("new-session", false, "Start a brand-new chat")
	gitrepo.AddFlags(sendCmd,
		"Clone a git repo into the sandbox this command creates. Accepts a local path or a git URL (HTTPS, SSH). If omitted and the cwd is in a git repo, that repo is used automatically",
		"Skip git repo auto-detection; create a sandbox without any repo")
	gitrepo.AddRepoAlias(sendCmd)
	sendCmd.Flags().Bool("stream", false, "Stream the reply as it is produced (default: on for a terminal, off when piped; always off with --output json)")
	rootCmd.AddCommand(sendCmd)

	sessionsListCmd.Flags().Int("limit", 0, "Maximum chats to list (default: the server's page size, 50)")
	sessionsCmd.AddCommand(sessionsListCmd)
	sessionsCmd.AddCommand(sessionsShowCmd)
	rootCmd.AddCommand(sessionsCmd)
}
