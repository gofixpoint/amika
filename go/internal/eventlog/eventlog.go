// Package eventlog records Claude Code and OpenAI Codex hook activity as raw,
// append-only events under the amika state directory, annotating every event
// with the git state of the directory the hook fired in.
//
// Capture is driven by the agents themselves: Init writes lifecycle hook
// entries into ~/.claude/settings.json and <codex-home>/hooks.json (one per
// hook event) that invoke `amikalog hook --source ...` on every hook call.
// Both agents deliver the hook payload on stdin with the same shape
// (session_id, cwd, hook_event_name, ...). Each invocation appends one JSON
// line to the session's append-only JSONL file:
//
//	<state>/events/<source>/sessions/<ts>_<session-id>.jsonl
//
// No daemon and no background process are involved. The state directory is the
// same one the rest of amika uses (see internal/config.StateDir), so
// AMIKA_STATE_DIRECTORY and the XDG variables apply.
//
// <codex-home> is $CODEX_HOME when set, otherwise ~/.codex (see CodexHome). For
// backward compatibility CaptureCodex also accepts the legacy Codex `notify`
// payload (passed as a positional argument rather than on stdin).
package eventlog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Source identifies the agent that produced an event.
type Source string

const (
	// SourceClaude is the source identifier for Claude Code events.
	SourceClaude Source = "claude"
	// SourceCodex is the source identifier for OpenAI Codex events.
	SourceCodex Source = "codex"
)

// EventsDir returns the directory under stateDir that holds a source's session
// files: <stateDir>/events/<source>/sessions.
func EventsDir(stateDir string, src Source) string {
	return filepath.Join(stateDir, "events", string(src), "sessions")
}

// hookInput is the subset of a lifecycle hook's stdin JSON that amikalog
// consumes to label an event. Claude Code and Codex share these field names.
// The full payload is preserved verbatim regardless.
type hookInput struct {
	SessionID     string `json:"session_id"`
	CWD           string `json:"cwd"`
	HookEventName string `json:"hook_event_name"`
}

// CaptureClaude reads the hook JSON Claude Code pipes on stdin and appends an
// event for it. The raw payload is stored unchanged; git context is gathered
// from the hook's reported cwd (falling back to the process cwd).
func CaptureClaude(stdin io.Reader, stateDir string) error {
	data, err := io.ReadAll(stdin)
	if err != nil {
		return fmt.Errorf("reading claude hook stdin: %w", err)
	}
	return captureLifecycle(SourceClaude, data, stateDir)
}

// CaptureCodex appends an event for a Codex hook invocation. Codex lifecycle
// hooks deliver the payload on stdin with the same shape as Claude, so that is
// the primary path. As a backward-compatibility fallback for the deprecated
// Codex `notify` program (which passes its payload as a positional argument and
// includes no session id), an empty stdin falls back to legacyArg, deriving the
// session id from the most recently modified rollout file.
func CaptureCodex(stdin io.Reader, legacyArg, homeDir, stateDir string) error {
	data, err := io.ReadAll(stdin)
	if err != nil {
		return fmt.Errorf("reading codex hook stdin: %w", err)
	}
	if len(bytesTrimSpace(data)) > 0 {
		return captureLifecycle(SourceCodex, data, stateDir)
	}
	return captureCodexNotify(legacyArg, homeDir, stateDir)
}

// captureLifecycle records an event from a lifecycle-hook stdin payload (shared
// by Claude and Codex). Malformed or empty JSON is tolerated: the event is
// still written with whatever fields parsed and the raw payload preserved.
func captureLifecycle(src Source, data []byte, stateDir string) error {
	var in hookInput
	_ = json.Unmarshal(data, &in)
	cwd := in.CWD
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	return writeEvent(stateDir, Event{
		Source:    src,
		HookEvent: in.HookEventName,
		SessionID: in.SessionID,
		CWD:       cwd,
		Git:       GatherGit(cwd),
		Payload:   rawPayload(data),
	})
}

// codexNotifyInput is the subset of Codex's legacy notify payload amikalog
// reads. notify carries no session id, so several plausible field names are
// accepted and captureCodexNotify derives one when none is present.
type codexNotifyInput struct {
	Type           string `json:"type"`
	SessionID      string `json:"session_id"`
	SessionIDDash  string `json:"session-id"`
	ConversationID string `json:"conversation_id"`
	ConvIDDash     string `json:"conversation-id"`
}

// sessionID returns the first non-empty id field, if any.
func (in codexNotifyInput) sessionID() string {
	for _, v := range []string{in.SessionID, in.SessionIDDash, in.ConversationID, in.ConvIDDash} {
		if v != "" {
			return v
		}
	}
	return ""
}

// captureCodexNotify records an event from a legacy Codex `notify` payload
// (passed as a positional argument), running in the repo's working directory.
func captureCodexNotify(arg, homeDir, stateDir string) error {
	data := []byte(arg)
	var in codexNotifyInput
	_ = json.Unmarshal(data, &in)

	sessionID := in.sessionID()
	if sessionID == "" {
		sessionID = deriveCodexSessionID(homeDir)
	}

	cwd, _ := os.Getwd()
	return writeEvent(stateDir, Event{
		Source:    SourceCodex,
		HookEvent: in.Type,
		SessionID: sessionID,
		CWD:       cwd,
		Git:       GatherGit(cwd),
		Payload:   rawPayload(data),
	})
}

// bytesTrimSpace reports the input with leading/trailing ASCII whitespace
// removed, used only to decide whether stdin carried a payload.
func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

// CodexHome returns the directory Codex uses for config, sessions, hooks and
// related state. It honors $CODEX_HOME, falling back to <homeDir>/.codex.
func CodexHome(homeDir string) string {
	if v := os.Getenv("CODEX_HOME"); v != "" {
		return v
	}
	return filepath.Join(homeDir, ".codex")
}

// CodexHooksFile returns the path to Codex's auto-loaded lifecycle hooks file
// (hooks.json) under homeDir's Codex home.
func CodexHooksFile(homeDir string) string {
	return filepath.Join(CodexHome(homeDir), "hooks.json")
}

// deriveCodexSessionID returns a stable session identifier for the Codex
// session that just completed a turn, taken from the basename (without the
// .jsonl suffix) of the most recently modified rollout file under
// <codex-home>/sessions. Returns "" when no rollout file can be found.
func deriveCodexSessionID(homeDir string) string {
	sessionsDir := filepath.Join(CodexHome(homeDir), "sessions")
	var newestPath string
	var newestMod int64 = -1
	walkErr := filepath.WalkDir(sessionsDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return filepath.SkipAll
			}
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		if mod := info.ModTime().UnixNano(); mod > newestMod {
			newestMod = mod
			newestPath = path
		}
		return nil
	})
	if walkErr != nil || newestPath == "" {
		return ""
	}
	return strings.TrimSuffix(filepath.Base(newestPath), ".jsonl")
}
