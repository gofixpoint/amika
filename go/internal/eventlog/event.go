package eventlog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// GitInfo is the git state of the working directory a hook fired in. A nil
// *GitInfo (serialized as JSON null) means the directory was not a git
// repository or git was unavailable.
type GitInfo struct {
	// RepoRoot is the absolute path to the repository's top-level directory.
	RepoRoot string `json:"repo_root"`
	// Commit is the full SHA of HEAD, or "" in a repository with no commits.
	Commit string `json:"commit"`
	// Branch is the abbreviated ref name of HEAD, or "HEAD" when detached.
	Branch string `json:"branch"`
	// Dirty reports whether the working tree had uncommitted changes.
	Dirty bool `json:"dirty"`
}

// Event is one captured agent hook call. It is the on-disk record amikalog
// appends; the schema is intended to stay stable so a later push step can
// upload event files verbatim.
type Event struct {
	// Source is the agent that fired the hook (claude or codex).
	Source Source `json:"source"`
	// HookEvent is the hook's event name: Claude's hook_event_name (e.g.
	// "PostToolUse") or Codex's notify payload type (e.g. "agent-turn-complete").
	HookEvent string `json:"hook_event"`
	// SessionID identifies the agent session this event belongs to.
	SessionID string `json:"session_id"`
	// Timestamp is when the event was captured (RFC3339 with nanoseconds, UTC).
	Timestamp string `json:"timestamp"`
	// Seq is the event's position within its session directory, starting at 0.
	Seq int `json:"seq"`
	// CWD is the working directory the hook reported (or the process cwd).
	CWD string `json:"cwd"`
	// Git is the git state of CWD, or nil when CWD is not a repository.
	Git *GitInfo `json:"git"`
	// Payload is the raw hook payload exactly as the agent provided it.
	Payload json.RawMessage `json:"payload"`
}

// fileTimestamp renders t as a filesystem-safe, lexically sortable UTC stamp,
// e.g. "20060102T150405.000000000Z". t is assumed to already be in UTC.
func fileTimestamp(t time.Time) string {
	return t.Format("20060102T150405.000000000") + "Z"
}

// rawPayload returns data as a json.RawMessage when it is valid JSON, otherwise
// wrapping the bytes as a JSON string so the event always round-trips.
func rawPayload(data []byte) json.RawMessage {
	if len(data) > 0 && json.Valid(data) {
		return json.RawMessage(data)
	}
	encoded, err := json.Marshal(string(data))
	if err != nil {
		return json.RawMessage(`""`)
	}
	return json.RawMessage(encoded)
}

// writeEvent appends ev as one JSON line to the session's JSONL file at
// <stateDir>/events/<source>/sessions/<ts>_<session-id>.jsonl.
//
// One file per session (rather than one file per event) keeps the on-disk tree
// small, so beta:push uploads a handful of session files instead of thousands
// of tiny event files. Writes are append-only: the line is appended and earlier
// lines are never modified.
//
// Concurrent hooks for the same session run as separate processes — Claude
// fires PostToolUse hooks in parallel for parallel tool calls — so an
// in-process mutex would not help. A cross-process advisory lock on the
// source's sessions directory makes the whole "resolve session file → count
// existing lines → append the next line" critical section atomic, so two
// processes cannot assign the same Seq, interleave their bytes in the file, or
// create two files for one brand-new session.
//
// The lock only serializes writers; beta:push reads each session file while
// holding the same lock so it can never observe a half-written final line.
func writeEvent(stateDir string, ev Event) error {
	now := time.Now().UTC()
	ev.Timestamp = now.Format(time.RFC3339Nano)

	root := EventsDir(stateDir, ev.Source)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return fmt.Errorf("creating events dir %s: %w", root, err)
	}

	lock, err := acquireLock(filepath.Join(root, lockFileName))
	if err != nil {
		return err
	}
	defer lock.release()

	sessionFile := resolveSessionFile(root, ev.SessionID, now)
	ev.Seq = countLines(sessionFile)
	return appendEvent(sessionFile, ev)
}

// appendEvent appends ev to path as a single newline-terminated JSON line. The
// event is marshaled fully before the lone Write call so a reader holding the
// same lock sees either the whole line or none of it.
//
// Before writing, any partial trailing record is dropped: a completed record
// always ends in '\n', so a non-newline tail is the remnant of an append that a
// returned error, a process kill, or a power loss interrupted. Removing it keeps
// records from concatenating, so the stream stays parseable and Seq cannot
// repeat — the crash-safety the old temp-file-and-rename layout gave. A short or
// failed write here is likewise rolled back to the pre-write length.
func appendEvent(path string, ev Event) error {
	line, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("encoding event for %s: %w", path, err)
	}
	line = append(line, '\n')

	// O_RDWR (not O_WRONLY) so the heal step can read the tail; O_APPEND still
	// forces the write itself to the current end.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("opening session file %s: %w", path, err)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("sizing session file %s: %w", path, err)
	}
	start, err := healPartialTail(f, info.Size())
	if err != nil {
		f.Close()
		return fmt.Errorf("healing session file %s: %w", path, err)
	}

	n, writeErr := f.Write(line)
	if writeErr != nil || n != len(line) {
		// Drop any bytes this append managed to write. The advisory lock is held,
		// so no concurrent writer can be sitting past start.
		_ = f.Truncate(start)
		f.Close()
		if writeErr == nil {
			writeErr = io.ErrShortWrite
		}
		return fmt.Errorf("appending event to %s: %w", path, writeErr)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("closing session file %s: %w", path, err)
	}
	return nil
}

// healPartialTail removes an incomplete trailing record (any bytes after the
// last newline) from f, returning the resulting size. The common case is cheap:
// a completed record ends in '\n', so when the file is empty or already ends in
// '\n' only the final byte is read. The file is read in full only in the rare
// case of a crash-interrupted tail. The caller holds the advisory lock, so such
// a tail can only be a dead writer's remnant, never a record in flight.
func healPartialTail(f *os.File, size int64) (int64, error) {
	if size == 0 {
		return 0, nil
	}
	last := make([]byte, 1)
	if _, err := f.ReadAt(last, size-1); err != nil {
		return 0, err
	}
	if last[0] == '\n' {
		return size, nil
	}
	buf := make([]byte, size)
	if _, err := f.ReadAt(buf, 0); err != nil {
		return 0, err
	}
	// LastIndexByte returns -1 when no newline exists (the whole file is one
	// unterminated record), so healed becomes 0 and the file is cleared.
	healed := int64(bytes.LastIndexByte(buf, '\n') + 1)
	if err := f.Truncate(healed); err != nil {
		return 0, err
	}
	return healed, nil
}

// resolveSessionFile returns the path to sessionID's JSONL file, named
// "<ts>_<session-id>.jsonl". An existing file is matched by its
// "_<session-id>.jsonl" suffix so a session's events keep accumulating in one
// file regardless of when it was first created. The file itself is created on
// first append by appendEvent.
func resolveSessionFile(root, sessionID string, now time.Time) string {
	safe := sanitizeSessionID(sessionID)
	if entries, err := os.ReadDir(root); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			base, ok := strings.CutSuffix(name, ".jsonl")
			if !ok {
				continue
			}
			if idx := strings.IndexByte(base, '_'); idx >= 0 && base[idx+1:] == safe {
				return filepath.Join(root, name)
			}
		}
	}
	return filepath.Join(root, fileTimestamp(now)+"_"+safe+".jsonl")
}

// countLines returns the number of newline-terminated lines (events) already in
// path, or 0 when the file does not yet exist. It is the next event's Seq.
func countLines(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	buf := make([]byte, 64*1024)
	for {
		c, readErr := f.Read(buf)
		for _, b := range buf[:c] {
			if b == '\n' {
				n++
			}
		}
		if readErr != nil {
			break
		}
	}
	return n
}

// sanitizeSessionID makes a session id safe to embed in a single path segment,
// replacing path separators and whitespace. Empty ids become "unknown".
func sanitizeSessionID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "unknown"
	}
	return strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ' ', '\t', '\n', '\r':
			return '-'
		}
		return r
	}, id)
}
