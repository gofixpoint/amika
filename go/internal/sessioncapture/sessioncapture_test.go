package sessioncapture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// useCodexFallback ensures CodexHome falls back to <home>/.codex by masking
// any ambient CODEX_HOME for the duration of the test. Tests that exercise
// the override use t.Setenv directly instead.
func useCodexFallback(t *testing.T) {
	t.Helper()
	t.Setenv("CODEX_HOME", "")
}

func TestCaptureClaude_MirrorsTranscript(t *testing.T) {
	tmp := t.TempDir()
	transcript := filepath.Join(tmp, "src", "abc.jsonl")
	if err := os.MkdirAll(filepath.Dir(transcript), 0o755); err != nil {
		t.Fatal(err)
	}
	const body = `{"role":"user","content":"hi"}` + "\n" + `{"role":"assistant","content":"hello"}` + "\n"
	if err := os.WriteFile(transcript, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	// Pin mtime so the derived day stamp is deterministic.
	day := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(transcript, day, day); err != nil {
		t.Fatal(err)
	}

	stateDir := filepath.Join(tmp, "state")
	payload := map[string]string{
		"session_id":      "abc",
		"transcript_path": transcript,
		"hook_event_name": "Stop",
	}
	stdin, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}

	if err := CaptureClaude(strings.NewReader(string(stdin)), stateDir); err != nil {
		t.Fatalf("CaptureClaude: %v", err)
	}
	mirrored, err := os.ReadFile(filepath.Join(stateDir, "sessions", "claude", "2026-05-14", "abc.jsonl"))
	if err != nil {
		t.Fatalf("reading mirror: %v", err)
	}
	if string(mirrored) != body {
		t.Errorf("mirrored body = %q, want %q", mirrored, body)
	}
}

func TestCaptureClaude_MissingTranscriptPath(t *testing.T) {
	stdin := strings.NewReader(`{"session_id":"abc"}`)
	err := CaptureClaude(stdin, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "transcript_path") {
		t.Fatalf("expected transcript_path error, got %v", err)
	}
}

func TestCaptureCodex_MirrorsAllChangedSessions(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	stateDir := filepath.Join(home, "state")

	// Two concurrent sessions on different days. Mirroring only the global
	// newest would skip whichever session wrote less recently — exactly
	// the regression this case guards against.
	a := filepath.Join(home, ".codex", "sessions", "2026", "06", "01", "rollout-a.jsonl")
	b := filepath.Join(home, ".codex", "sessions", "2026", "06", "02", "rollout-b.jsonl")
	for _, p := range []string{a, b} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(a, []byte(`{"k":"a-turn-1"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, []byte(`{"k":"b-turn-1"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Make a older than b so a clearly isn't the global newest.
	past := time.Now().Add(-1 * time.Hour)
	if err := os.Chtimes(a, past, past); err != nil {
		t.Fatal(err)
	}

	if err := CaptureCodex(home, stateDir); err != nil {
		t.Fatalf("CaptureCodex: %v", err)
	}

	// Day stamp comes from the source path so basenames can't collide across days.
	gotA, err := os.ReadFile(filepath.Join(stateDir, "sessions", "codex", "2026-06-01", "rollout-a.jsonl"))
	if err != nil {
		t.Fatalf("session a not mirrored: %v", err)
	}
	if !strings.Contains(string(gotA), "a-turn-1") {
		t.Errorf("session a mirror has unexpected content: %s", gotA)
	}
	gotB, err := os.ReadFile(filepath.Join(stateDir, "sessions", "codex", "2026-06-02", "rollout-b.jsonl"))
	if err != nil {
		t.Fatalf("session b not mirrored: %v", err)
	}
	if !strings.Contains(string(gotB), "b-turn-1") {
		t.Errorf("session b mirror has unexpected content: %s", gotB)
	}
}

func TestCaptureCodex_SkipsUpToDateMirrors(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	stateDir := filepath.Join(home, "state")

	a := filepath.Join(home, ".codex", "sessions", "2026", "06", "01", "a.jsonl")
	b := filepath.Join(home, ".codex", "sessions", "2026", "06", "01", "b.jsonl")
	for _, p := range []string{a, b} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(a, []byte("a-v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, []byte("b-v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := CaptureCodex(home, stateDir); err != nil {
		t.Fatalf("CaptureCodex first: %v", err)
	}

	mirrorB := filepath.Join(stateDir, "sessions", "codex", "2026-06-01", "b.jsonl")
	infoBefore, err := os.Stat(mirrorB)
	if err != nil {
		t.Fatal(err)
	}

	// Only `a` advances on disk; `b` is unchanged. The second capture
	// should rewrite a's mirror but leave b's alone (verified via mtime).
	future := time.Now().Add(2 * time.Second)
	if err := os.WriteFile(a, []byte("a-v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(a, future, future); err != nil {
		t.Fatal(err)
	}

	if err := CaptureCodex(home, stateDir); err != nil {
		t.Fatalf("CaptureCodex second: %v", err)
	}

	gotA, err := os.ReadFile(filepath.Join(stateDir, "sessions", "codex", "2026-06-01", "a.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(gotA), "a-v2") {
		t.Errorf("a's mirror not refreshed: %s", gotA)
	}

	infoAfter, err := os.Stat(mirrorB)
	if err != nil {
		t.Fatal(err)
	}
	if !infoAfter.ModTime().Equal(infoBefore.ModTime()) {
		t.Errorf("b's mirror mtime changed (%v → %v), expected no rewrite", infoBefore.ModTime(), infoAfter.ModTime())
	}
}

func TestCaptureCodex_NoSessionsIsNoOp(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	stateDir := filepath.Join(home, "state")
	if err := CaptureCodex(home, stateDir); err != nil {
		t.Fatalf("CaptureCodex with no sessions: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "sessions", "codex")); !os.IsNotExist(err) {
		t.Errorf("expected no capture dir to be created, got %v", err)
	}
}

func TestCaptureCodex_HonorsCODEX_HOME(t *testing.T) {
	home := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)

	// A file under ~/.codex/sessions must NOT be picked up when CODEX_HOME
	// points elsewhere — otherwise we'd mirror a stale path.
	bogus := filepath.Join(home, ".codex", "sessions", "2026", "01", "01", "wrong.jsonl")
	if err := os.MkdirAll(filepath.Dir(bogus), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bogus, []byte(`{"k":"wrong"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(codexHome, "sessions", "2026", "06", "01", "right.jsonl")
	if err := os.MkdirAll(filepath.Dir(want), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(want, []byte(`{"k":"right"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	stateDir := filepath.Join(home, "state")
	if err := CaptureCodex(home, stateDir); err != nil {
		t.Fatalf("CaptureCodex: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(stateDir, "sessions", "codex", "2026-06-01", "right.jsonl"))
	if err != nil {
		t.Fatalf("expected right.jsonl to be mirrored: %v", err)
	}
	if !strings.Contains(string(got), `"right"`) {
		t.Errorf("unexpected mirrored content: %s", got)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "sessions", "codex", "2026-01-01", "wrong.jsonl")); !os.IsNotExist(err) {
		t.Errorf("file under ~/.codex was mirrored despite CODEX_HOME override")
	}
}
