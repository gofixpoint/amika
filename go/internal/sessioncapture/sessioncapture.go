// Package sessioncapture mirrors Claude Code and OpenAI Codex session
// transcripts into the amika state directory.
//
// Capture is driven by the agents themselves: `Init` writes hook entries into
// `~/.claude/settings.json` (Stop hook) and `<codex-home>/config.toml`
// (notify program) that invoke `amika sessions capture --source ...`
// whenever the agent finishes a turn. Each invocation copies the relevant
// session JSONL into `<state>/raw-sessions/<source>/<YYYY-MM-DD>/`, grouping a
// day's sessions together. No daemon, no background process.
//
// Alongside each mirrored transcript, capture maintains a `<stem>.meta.json`
// sidecar (see meta.go) recording, per turn, the git commit/branch the work
// happened on plus the tool calls that turn made — so a session that switches
// branches mid-stream leaves a turn-by-turn record of where each turn landed.
//
// `<codex-home>` is `$CODEX_HOME` when set, otherwise `~/.codex` (see
// CodexHome). Honoring the env var matters because Codex itself reads
// config and writes sessions there, not under `~/.codex`.
package sessioncapture

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Source identifies the agent that produced the session being captured.
type Source string

const (
	// SourceClaude is the source identifier for Claude Code sessions.
	SourceClaude Source = "claude"
	// SourceCodex is the source identifier for OpenAI Codex sessions.
	SourceCodex Source = "codex"
)

// CaptureDir returns the directory under stateDir where mirrored sessions
// for the given source live.
func CaptureDir(stateDir string, src Source) string {
	return filepath.Join(stateDir, "raw-sessions", string(src))
}

// claudeStopHookInput is the JSON shape Claude Code pipes on stdin when a
// `Stop` hook fires. Only the fields amika consumes are listed.
type claudeStopHookInput struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	// Cwd is the working directory Claude reports for the session. We prefer
	// the per-entry cwd recorded in the transcript, but fall back to this
	// when the transcript carries none (e.g. an empty transcript).
	Cwd string `json:"cwd"`
}

// CaptureClaude reads the Stop-hook JSON Claude pipes on stdin and copies
// the referenced transcript into the amika state directory.
//
// Mirrors land under a `YYYY-MM-DD/` subdirectory derived from the
// transcript file's mtime, so a day's sessions sit together without nesting
// year/month/day directories.
func CaptureClaude(stdin io.Reader, stateDir string) error {
	data, err := io.ReadAll(stdin)
	if err != nil {
		return fmt.Errorf("reading claude hook stdin: %w", err)
	}
	var in claudeStopHookInput
	if err := json.Unmarshal(data, &in); err != nil {
		return fmt.Errorf("decoding claude hook stdin: %w", err)
	}
	if in.TranscriptPath == "" {
		return errors.New("claude hook input missing transcript_path")
	}
	info, err := os.Stat(in.TranscriptPath)
	if err != nil {
		return fmt.Errorf("statting claude transcript %s: %w", in.TranscriptPath, err)
	}
	name := filepath.Base(in.TranscriptPath)
	if in.SessionID != "" && !strings.HasSuffix(name, ".jsonl") {
		name = in.SessionID + ".jsonl"
	}
	day := info.ModTime().Format("2006-01-02")
	dst := filepath.Join(CaptureDir(stateDir, SourceClaude), day, name)
	if err := copyFile(in.TranscriptPath, dst); err != nil {
		return err
	}
	return updateClaudeMeta(metaPathFor(dst), in)
}

// CaptureCodex mirrors every Codex session file whose source mtime is newer
// than its mirror (or that has no mirror yet) under the Codex state root
// into the amika state directory.
//
// Codex's notify payload does not include a session path. Picking only the
// globally newest file across the tree would skip a turn whenever a second
// concurrent Codex session wrote something more recently — so we walk the
// whole tree and copy any file that's changed. Mirrors flatten Codex's
// nested `YYYY/MM/DD/<rollout>.jsonl` source layout into a single
// `YYYY-MM-DD/<rollout>.jsonl` directory under `<state>/sessions/codex/` —
// session basenames are unique so nothing collides within a day.
//
// The Codex state root is `$CODEX_HOME` when set, falling back to
// `<homeDir>/.codex`. Returns nil with no error when no Codex session
// directory exists yet.
func CaptureCodex(homeDir, stateDir string) error {
	sessionsDir := filepath.Join(CodexHome(homeDir), "sessions")
	dstRoot := CaptureDir(stateDir, SourceCodex)

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
		rel, relErr := filepath.Rel(sessionsDir, path)
		if relErr != nil {
			return relErr
		}
		day, ok := codexDayFromRel(rel)
		if !ok {
			info, statErr := os.Stat(path)
			if statErr != nil {
				return statErr
			}
			day = info.ModTime().Format("2006-01-02")
		}
		dst := filepath.Join(dstRoot, day, filepath.Base(rel))

		fresh, freshErr := mirrorIsFresh(path, dst)
		if freshErr != nil {
			return freshErr
		}
		if fresh {
			return nil
		}
		if err := copyFile(path, dst); err != nil {
			return err
		}
		// Metadata is best-effort: the mirrored transcript is the artifact
		// that must not be lost, so a meta failure never aborts the walk.
		_ = updateCodexMeta(metaPathFor(dst), path)
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, os.ErrNotExist) {
		return walkErr
	}
	return nil
}

// codexDayFromRel extracts a `YYYY-MM-DD` day stamp from a Codex session
// relative path of the form `YYYY/MM/DD/<rollout>.jsonl`. Returns ok=false
// if the path doesn't have that shape so callers can fall back to mtime.
func codexDayFromRel(rel string) (string, bool) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 4 {
		return "", false
	}
	y, m, d := parts[0], parts[1], parts[2]
	if len(y) != 4 || len(m) != 2 || len(d) != 2 {
		return "", false
	}
	for _, s := range []string{y, m, d} {
		for _, r := range s {
			if r < '0' || r > '9' {
				return "", false
			}
		}
	}
	return y + "-" + m + "-" + d, true
}

// CodexHome returns the directory Codex uses for config, sessions, auth and
// related state. Honors the `CODEX_HOME` environment variable when set,
// falling back to `<homeDir>/.codex`.
func CodexHome(homeDir string) string {
	if v := os.Getenv("CODEX_HOME"); v != "" {
		return v
	}
	return filepath.Join(homeDir, ".codex")
}

// mirrorIsFresh reports whether dst exists and its mtime is at least as new
// as src's. Used to skip rewrites of session files we've already mirrored.
func mirrorIsFresh(src, dst string) (bool, error) {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return false, err
	}
	dstInfo, err := os.Stat(dst)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return !srcInfo.ModTime().After(dstInfo.ModTime()), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("opening session source %s: %w", src, err)
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("creating capture dir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".capture-*")
	if err != nil {
		return fmt.Errorf("creating capture tempfile: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		if tmpPath != "" {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return fmt.Errorf("copying session contents: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing capture tempfile: %w", err)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return fmt.Errorf("renaming capture file to %s: %w", dst, err)
	}
	tmpPath = ""
	return nil
}
