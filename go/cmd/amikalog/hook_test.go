package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// countEvents walks dir and counts events recorded across all session JSONL
// files (one event per line).
func countEvents(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		n += strings.Count(string(data), "\n")
		return nil
	})
	return n
}

func TestHook_Claude_WritesEvent(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)

	payload := `{"session_id":"abc","cwd":"` + t.TempDir() + `","hook_event_name":"PostToolUse"}`
	if _, err := runRootCommandStdin(strings.NewReader(payload), "hook", "--source", "claude"); err != nil {
		t.Fatalf("hook --source claude: %v", err)
	}
	if got := countEvents(t, filepath.Join(stateDir, "events", "claude")); got != 1 {
		t.Fatalf("got %d claude events, want 1", got)
	}
}

func TestHook_Codex_WritesEventFromStdin(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")

	payload := `{"session_id":"cdx","cwd":"` + t.TempDir() + `","hook_event_name":"PreToolUse"}`
	if _, err := runRootCommandStdin(strings.NewReader(payload), "hook", "--source", "codex"); err != nil {
		t.Fatalf("hook --source codex (stdin): %v", err)
	}
	if got := countEvents(t, filepath.Join(stateDir, "events", "codex")); got != 1 {
		t.Fatalf("got %d codex events, want 1", got)
	}
}

// TestHook_Codex_AcceptsNotifyPayload guards the legacy fallback: the
// deprecated Codex notify program appends one trailing JSON payload to the
// configured argv (with empty stdin), so the command must still accept it.
func TestHook_Codex_AcceptsNotifyPayload(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")

	payload := `{"type":"agent-turn-complete","turn-id":"t1"}`
	if _, err := runRootCommand("hook", "--source", "codex", payload); err != nil {
		t.Fatalf("hook --source codex with payload: %v", err)
	}
	if got := countEvents(t, filepath.Join(stateDir, "events", "codex")); got != 1 {
		t.Fatalf("got %d codex events, want 1", got)
	}
}

func TestHook_UnknownSource(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	if _, err := runRootCommand("hook", "--source", "bogus"); err == nil {
		t.Fatal("expected error for unknown --source, got nil")
	}
}
