package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSessionsCapture_AcceptsCodexNotifyPayload guards against re-introducing
// `cobra.NoArgs` on the capture command: Codex's notify hook appends one
// trailing JSON payload to the configured argv, so the command must accept
// it or session capture from Codex breaks entirely.
func TestSessionsCapture_AcceptsCodexNotifyPayload(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("CODEX_HOME", "")

	home := t.TempDir()
	t.Setenv("HOME", home)

	// Seed a session so CaptureCodex has something to mirror.
	dir := filepath.Join(home, ".codex", "sessions", "2026", "06", "01")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "rollout-1.jsonl")
	if err := os.WriteFile(src, []byte(`{"k":"hi"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	payload := `{"type":"agent-turn-complete","turn-id":"abc","last-assistant-message":"done"}`
	out, err := runRootCommand("sessions", "capture", "--source", "codex", payload)
	if err != nil {
		t.Fatalf("capture with codex notify payload failed: %v (out=%q)", err, out)
	}

	stateDir := os.Getenv("AMIKA_STATE_DIRECTORY")
	mirrored, err := os.ReadFile(filepath.Join(stateDir, "raw-sessions", "codex", "2026-06-01", "rollout-1.jsonl"))
	if err != nil {
		t.Fatalf("mirror missing: %v", err)
	}
	if !strings.Contains(string(mirrored), `"hi"`) {
		t.Errorf("unexpected mirrored content: %s", mirrored)
	}
}

// TestSessionsCaptureInit_PrintsDestinations ensures `capture-init` tells the
// user where mirrored sessions will land, so they don't have to grep the help
// text or guess the XDG path.
func TestSessionsCaptureInit_PrintsDestinations(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CODEX_HOME", "")

	out, err := runRootCommand("sessions", "capture-init")
	if err != nil {
		t.Fatalf("capture-init: %v (out=%q)", err, out)
	}
	for _, want := range []string{
		"Captures will be written to:",
		filepath.Join(stateDir, "raw-sessions", "claude"),
		filepath.Join(stateDir, "raw-sessions", "codex"),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n--- got ---\n%s", want, out)
		}
	}
}

func TestSessionsCapture_RejectsExtraArgs(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	// Two positionals exceeds Codex's one-payload contract; cobra should
	// reject this so misconfigurations surface instead of being silently
	// accepted.
	_, err := runRootCommand("sessions", "capture", "--source", "codex", "a", "b")
	if err == nil {
		t.Fatal("expected error for >1 positional, got nil")
	}
}
