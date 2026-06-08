package sessioncapture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubGit swaps resolveGitState for the duration of a test, returning a queued
// gitInfo per call so a sequence of turns can simulate branch/commit switches.
func stubGit(t *testing.T, states ...*gitInfo) {
	t.Helper()
	prev := resolveGitState
	calls := 0
	resolveGitState = func(cwd string) (*gitInfo, *repoInfo) {
		g := states[calls%len(states)]
		calls++
		return g, &repoInfo{Root: cwd, RemoteURL: "git@example.com:org/repo.git"}
	}
	t.Cleanup(func() { resolveGitState = prev })
}

func pinNow(t *testing.T) {
	t.Helper()
	prev := nowFunc
	nowFunc = func() time.Time { return time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { nowFunc = prev })
}

// captureClaudeWith mirrors a transcript whose mtime is pinned to a fixed day
// so the sidecar path is deterministic, then returns the parsed sidecar.
func captureClaudeWith(t *testing.T, transcript, stateDir, sessionID string) sessionMeta {
	t.Helper()
	day := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(transcript, day, day); err != nil {
		t.Fatal(err)
	}
	stdin, err := json.Marshal(map[string]string{
		"session_id":      sessionID,
		"transcript_path": transcript,
		"hook_event_name": "Stop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := CaptureClaude(strings.NewReader(string(stdin)), stateDir); err != nil {
		t.Fatalf("CaptureClaude: %v", err)
	}
	metaPath := filepath.Join(stateDir, "raw-sessions", "claude", "2026-05-14", sessionID+".meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("reading sidecar %s: %v", metaPath, err)
	}
	var meta sessionMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatalf("decoding sidecar: %v", err)
	}
	return meta
}

func assistantToolLine(branch, toolName, toolID string) string {
	return `{"type":"assistant","cwd":"/repo","gitBranch":"` + branch +
		`","message":{"role":"assistant","content":[{"type":"tool_use","id":"` + toolID +
		`","name":"` + toolName + `","input":{"k":"v"}}]}}`
}

func TestCaptureClaude_WritesMetaSidecar(t *testing.T) {
	pinNow(t)
	stubGit(t, &gitInfo{Commit: "a1b2c3d", Branch: "main", Dirty: true})

	tmp := t.TempDir()
	transcript := filepath.Join(tmp, "abc.jsonl")
	body := `{"type":"user","cwd":"/repo","message":{"role":"user","content":"hi"}}` + "\n" +
		assistantToolLine("main", "Bash", "t1") + "\n"
	if err := os.WriteFile(transcript, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	meta := captureClaudeWith(t, transcript, filepath.Join(tmp, "state"), "abc")

	if meta.Source != SourceClaude || meta.SessionID != "abc" {
		t.Errorf("unexpected meta header: %+v", meta)
	}
	if meta.Repo == nil || meta.Repo.RemoteURL == "" {
		t.Errorf("expected repo info, got %+v", meta.Repo)
	}
	if len(meta.Captures) != 1 {
		t.Fatalf("expected 1 capture, got %d", len(meta.Captures))
	}
	c := meta.Captures[0]
	if c.Git == nil || c.Git.Commit != "a1b2c3d" || c.Git.Branch != "main" || !c.Git.Dirty {
		t.Errorf("unexpected git state: %+v", c.Git)
	}
	if len(c.Tools) != 1 || c.Tools[0].Name != "Bash" || c.Tools[0].ID != "t1" {
		t.Errorf("unexpected tools: %+v", c.Tools)
	}
	if !strings.Contains(string(c.Tools[0].Input), `"k"`) || !strings.Contains(string(c.Tools[0].Input), `"v"`) {
		t.Errorf("tool input not preserved: %s", c.Tools[0].Input)
	}
}

// TestCaptureClaude_PerTurnTimelineAcrossBranchSwitch is the core case: a
// session that switches branches between turns must leave one capture per turn
// with the commit/branch each turn ran on, and each turn's tools sliced off
// the growing transcript via the stored cursor.
func TestCaptureClaude_PerTurnTimelineAcrossBranchSwitch(t *testing.T) {
	pinNow(t)
	stubGit(t,
		&gitInfo{Commit: "aaaaaaa", Branch: "main"},
		&gitInfo{Commit: "bbbbbbb", Branch: "feature"},
	)

	tmp := t.TempDir()
	stateDir := filepath.Join(tmp, "state")
	transcript := filepath.Join(tmp, "sess.jsonl")

	// Turn 1: one tool call on main.
	turn1 := `{"type":"user","cwd":"/repo","message":{"role":"user","content":"hi"}}` + "\n" +
		assistantToolLine("main", "Read", "t1") + "\n"
	if err := os.WriteFile(transcript, []byte(turn1), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := captureClaudeWith(t, transcript, stateDir, "sess")
	if len(meta.Captures) != 1 {
		t.Fatalf("after turn 1: expected 1 capture, got %d", len(meta.Captures))
	}

	// Turn 2: user switched branches, then a tool call on feature.
	turn2 := assistantToolLine("feature", "Edit", "t2") + "\n"
	f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(turn2); err != nil {
		t.Fatal(err)
	}
	f.Close()

	meta = captureClaudeWith(t, transcript, stateDir, "sess")
	if len(meta.Captures) != 2 {
		t.Fatalf("after turn 2: expected 2 captures, got %d", len(meta.Captures))
	}

	c1, c2 := meta.Captures[0], meta.Captures[1]
	if c1.Git.Commit != "aaaaaaa" || c1.Git.Branch != "main" {
		t.Errorf("turn 1 git = %+v, want main/aaaaaaa", c1.Git)
	}
	if len(c1.Tools) != 1 || c1.Tools[0].Name != "Read" {
		t.Errorf("turn 1 tools = %+v, want [Read]", c1.Tools)
	}
	if c2.Git.Commit != "bbbbbbb" || c2.Git.Branch != "feature" {
		t.Errorf("turn 2 git = %+v, want feature/bbbbbbb", c2.Git)
	}
	// The cursor must slice only turn 2's new line — not re-record Read.
	if len(c2.Tools) != 1 || c2.Tools[0].Name != "Edit" {
		t.Errorf("turn 2 tools = %+v, want [Edit] only", c2.Tools)
	}
}

func TestCaptureCodex_WritesMetaSidecar(t *testing.T) {
	useCodexFallback(t)
	pinNow(t)

	home := t.TempDir()
	stateDir := filepath.Join(home, "state")
	rollout := filepath.Join(home, ".codex", "sessions", "2026", "06", "01", "r.jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"type":"session_meta","payload":{"cwd":"/repo","git":{"commit_hash":"deadbeef","branch":"main","repository_url":"git@example.com:org/repo.git"}}}` + "\n" +
		`{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"ls\"]}"}}` + "\n"
	if err := os.WriteFile(rollout, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := CaptureCodex(home, stateDir); err != nil {
		t.Fatalf("CaptureCodex: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(stateDir, "raw-sessions", "codex", "2026-06-01", "r.meta.json"))
	if err != nil {
		t.Fatalf("reading codex sidecar: %v", err)
	}
	var meta sessionMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatalf("decoding sidecar: %v", err)
	}
	if meta.Source != SourceCodex || meta.SessionID != "r" {
		t.Errorf("unexpected header: %+v", meta)
	}
	if len(meta.Captures) != 1 {
		t.Fatalf("expected 1 capture, got %d", len(meta.Captures))
	}
	c := meta.Captures[0]
	if c.Git == nil || c.Git.Commit != "deadbeef" || c.Git.Branch != "main" {
		t.Errorf("unexpected git: %+v", c.Git)
	}
	if meta.Repo == nil || meta.Repo.RemoteURL != "git@example.com:org/repo.git" {
		t.Errorf("unexpected repo: %+v", meta.Repo)
	}
	if len(c.Tools) != 1 || c.Tools[0].Name != "shell" || c.Tools[0].ID != "c1" {
		t.Fatalf("unexpected tools: %+v", c.Tools)
	}
	// Arguments should be unwrapped from the JSON-string into an object.
	if !strings.Contains(string(c.Tools[0].Input), `"command"`) || strings.HasPrefix(string(c.Tools[0].Input), `"`) {
		t.Errorf("codex args not normalized: %s", c.Tools[0].Input)
	}
}
