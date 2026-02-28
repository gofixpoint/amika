package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuthExtract_ExportMappingAndSorting(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{"ANTHROPIC_API_KEY":"anth-key","OPENAI_API_KEY":"open-key"}`)
	writeJSONFixture(t, filepath.Join(home, ".config", "opencode", "auth.json"), `{"foo-bar":{"api_key":"foo-key"}}`)

	cmd := exec.Command(bin, "auth", "extract", "--export", "--homedir", home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika auth extract failed: %v\n%s", err, out)
	}

	gotLines := strings.Split(strings.TrimSpace(string(out)), "\n")
	wantLines := []string{
		"export ANTHROPIC_API_KEY='anth-key'",
		"export CLAUDE_API_KEY='anth-key'",
		"export CODEX_API_KEY='open-key'",
		"export FOO_BAR_API_KEY='foo-key'",
		"export OPENAI_API_KEY='open-key'",
	}
	if strings.TrimSpace(string(out)) == "" {
		t.Fatal("expected non-empty stdout")
	}
	if len(gotLines) != len(wantLines) {
		t.Fatalf("line count = %d, want %d\noutput:\n%s", len(gotLines), len(wantLines), out)
	}
	for i := range wantLines {
		if gotLines[i] != wantLines[i] {
			t.Fatalf("line %d = %q, want %q", i+1, gotLines[i], wantLines[i])
		}
	}
}

func TestAuthExtract_NoOAuth(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".config", "amika", "oauth.json"), `{"OPENAI_API_KEY":"oauth-open","GROQ_API_KEY":"oauth-groq"}`)

	cmdWithOAuth := exec.Command(bin, "auth", "extract", "--homedir", home)
	outWithOAuth, err := cmdWithOAuth.CombinedOutput()
	if err != nil {
		t.Fatalf("amika auth extract failed: %v\n%s", err, outWithOAuth)
	}
	textWithOAuth := string(outWithOAuth)
	if !strings.Contains(textWithOAuth, "OPENAI_API_KEY='oauth-open'") {
		t.Fatalf("expected OPENAI credential in output, got:\n%s", textWithOAuth)
	}
	if !strings.Contains(textWithOAuth, "GROQ_API_KEY='oauth-groq'") {
		t.Fatalf("expected GROQ credential in output, got:\n%s", textWithOAuth)
	}

	cmdNoOAuth := exec.Command(bin, "auth", "extract", "--homedir", home, "--no-oauth")
	outNoOAuth, err := cmdNoOAuth.CombinedOutput()
	if err != nil {
		t.Fatalf("amika auth extract --no-oauth failed: %v\n%s", err, outNoOAuth)
	}
	if strings.TrimSpace(string(outNoOAuth)) != "" {
		t.Fatalf("expected empty stdout with --no-oauth, got:\n%s", outNoOAuth)
	}
}

func TestAuthExtract_ParseError(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{not-json}`)

	cmd := exec.Command(bin, "auth", "extract", "--homedir", home)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "failed to parse credentials file") {
		t.Fatalf("expected parse error message, got:\n%s", out)
	}
}

func writeJSONFixture(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("failed to create fixture dir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write fixture %s: %v", path, err)
	}
}
