package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSecretsExtract_MappingAndSorting(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{"apiKey":"sk-ant-anth-key"}`)
	writeJSONFixture(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"open-key"}`)
	writeJSONFixture(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), `{"foo-bar":{"type":"api","key":"foo-key"}}`)

	cmd := exec.Command(bin, "secrets", "extract", "--homedir", home)
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secrets extract failed: %v\n%s", err, out)
	}

	text := string(out)
	for _, want := range []string{"ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CODEX_API_KEY", "FOO_BAR_API_KEY", "OPENAI_API_KEY"} {
		if !strings.Contains(text, want) {
			t.Errorf("expected %q in output, got:\n%s", want, text)
		}
	}
}

func TestSecretsExtract_NoOAuth(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()
	future := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)

	writeJSONFixture(t, filepath.Join(home, ".claude-oauth-credentials.json"), `{"claudeAiOauth":{"accessToken":"claude-oauth","expiresAt":"`+future+`"}}`)
	writeJSONFixture(t, filepath.Join(home, ".codex", "auth.json"), `{"tokens":{"access_token":"codex-oauth"}}`)
	writeJSONFixture(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), `{"openai":{"type":"oauth","access":"op-open"},"groq":{"type":"oauth","access":"op-groq"}}`)

	cmdWithOAuth := exec.Command(bin, "secrets", "extract", "--homedir", home)
	cmdWithOAuth.Env = withXDGEnv(home)
	outWithOAuth, err := cmdWithOAuth.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secrets extract failed: %v\n%s", err, outWithOAuth)
	}
	textWithOAuth := string(outWithOAuth)
	if !strings.Contains(textWithOAuth, "ANTHROPIC_API_KEY") {
		t.Fatalf("expected Claude OAuth credential in output, got:\n%s", textWithOAuth)
	}
	if !strings.Contains(textWithOAuth, "OPENAI_API_KEY") {
		t.Fatalf("expected Codex OAuth credential in output, got:\n%s", textWithOAuth)
	}
	if !strings.Contains(textWithOAuth, "GROQ_API_KEY") {
		t.Fatalf("expected OpenCode OAuth generic credential in output, got:\n%s", textWithOAuth)
	}

	cmdNoOAuth := exec.Command(bin, "secrets", "extract", "--homedir", home, "--no-oauth")
	cmdNoOAuth.Env = withXDGEnv(home)
	outNoOAuth, err := cmdNoOAuth.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secrets extract --no-oauth failed: %v\n%s", err, outNoOAuth)
	}
	text := string(outNoOAuth)
	if !strings.Contains(text, "No secrets discovered") {
		t.Fatalf("expected 'No secrets discovered' with --no-oauth, got:\n%s", text)
	}
}

func TestSecretsExtract_OnlyFilter(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{"apiKey":"sk-ant-anth-key"}`)
	writeJSONFixture(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"open-key"}`)

	cmd := exec.Command(bin, "secrets", "extract", "--homedir", home, "--only=ANTHROPIC_API_KEY")
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secrets extract --only failed: %v\n%s", err, out)
	}

	text := string(out)
	if !strings.Contains(text, "ANTHROPIC_API_KEY") {
		t.Fatalf("expected ANTHROPIC_API_KEY in output, got:\n%s", text)
	}
	if strings.Contains(text, "OPENAI_API_KEY") {
		t.Fatalf("expected OPENAI_API_KEY to be filtered out, got:\n%s", text)
	}
}

func TestSecretsExtract_OnlyFilterNoMatch(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{"apiKey":"sk-ant-anth-key"}`)

	cmd := exec.Command(bin, "secrets", "extract", "--homedir", home, "--only=NONEXISTENT_KEY")
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secrets extract --only failed: %v\n%s", err, out)
	}

	if !strings.Contains(string(out), "No secrets match the --only filter") {
		t.Fatalf("expected filter-no-match message, got:\n%s", out)
	}
}

func TestSecretsExtract_ParseError(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{not-json}`)

	cmd := exec.Command(bin, "secrets", "extract", "--homedir", home)
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "failed to parse credentials file") {
		t.Fatalf("expected parse error message, got:\n%s", out)
	}
}

func TestSecretsPush_InvalidArg(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secrets", "push", "NOEQUALS")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "expected KEY=VALUE") {
		t.Fatalf("expected KEY=VALUE error, got:\n%s", out)
	}
}

func TestSecretsPush_NoArgs(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secrets", "push")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "no secrets provided") {
		t.Fatalf("expected 'no secrets provided' error, got:\n%s", out)
	}
}

func TestSecretsPush_FromEnvMissing(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secrets", "push", "--from-env=DEFINITELY_NOT_SET_XYZ")
	// Ensure the env var is not set.
	cmd.Env = append(os.Environ(), "DEFINITELY_NOT_SET_XYZ=")
	// Actually remove it by filtering.
	var env []string
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "DEFINITELY_NOT_SET_XYZ=") {
			env = append(env, e)
		}
	}
	cmd.Env = env

	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "is not set") {
		t.Fatalf("expected 'is not set' error, got:\n%s", out)
	}
}

func TestMaskValue(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"short", "*****"},
		{"exactly12ch", "***********"},
		{"sk-ant-a-long-secret-key", "sk-a****************-key"},
	}
	for _, tt := range tests {
		got := maskValue(tt.input)
		if got != tt.want {
			t.Errorf("maskValue(%q) = %q, want %q", tt.input, got, tt.want)
		}
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

func withXDGEnv(home string) []string {
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"XDG_CONFIG_HOME="+filepath.Join(home, ".config"),
		"XDG_DATA_HOME="+filepath.Join(home, ".local", "share"),
		"XDG_CACHE_HOME="+filepath.Join(home, ".cache"),
		"XDG_STATE_HOME="+filepath.Join(home, ".local", "state"),
	)
	return env
}
