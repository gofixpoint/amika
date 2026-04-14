package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

	cmd := exec.Command(bin, "secret", "extract", "--homedir", home)
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secret extract failed: %v\n%s", err, out)
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

	cmdWithOAuth := exec.Command(bin, "secret", "extract", "--homedir", home)
	cmdWithOAuth.Env = withXDGEnv(home)
	outWithOAuth, err := cmdWithOAuth.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secret extract failed: %v\n%s", err, outWithOAuth)
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

	cmdNoOAuth := exec.Command(bin, "secret", "extract", "--homedir", home, "--no-oauth")
	cmdNoOAuth.Env = withXDGEnv(home)
	outNoOAuth, err := cmdNoOAuth.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secret extract --no-oauth failed: %v\n%s", err, outNoOAuth)
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

	cmd := exec.Command(bin, "secret", "extract", "--homedir", home, "--only=ANTHROPIC_API_KEY")
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secret extract --only failed: %v\n%s", err, out)
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

	cmd := exec.Command(bin, "secret", "extract", "--homedir", home, "--only=NONEXISTENT_KEY")
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secret extract --only failed: %v\n%s", err, out)
	}

	if !strings.Contains(string(out), "No secrets match the --only filter") {
		t.Fatalf("expected filter-no-match message, got:\n%s", out)
	}
}

func TestSecretsExtract_ParseError(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{not-json}`)

	cmd := exec.Command(bin, "secret", "extract", "--homedir", home)
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

	cmd := exec.Command(bin, "secret", "push", "NOEQUALS")
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

	cmd := exec.Command(bin, "secret", "push")
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

	cmd := exec.Command(bin, "secret", "push", "--from-env=DEFINITELY_NOT_SET_XYZ")
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

func TestSecretsPluralAlias(t *testing.T) {
	bin := buildAmika(t)
	home := t.TempDir()

	writeJSONFixture(t, filepath.Join(home, ".claude.json"), `{"apiKey":"sk-ant-anth-key"}`)

	cmd := exec.Command(bin, "secrets", "extract", "--homedir", home)
	cmd.Env = withXDGEnv(home)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika secrets (plural alias) extract failed: %v\n%s", err, out)
	}

	if !strings.Contains(string(out), "ANTHROPIC_API_KEY") {
		t.Fatalf("expected ANTHROPIC_API_KEY in output from plural alias, got:\n%s", out)
	}
}

func TestParseEnvFile(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		wantKeys []string
		wantVals map[string]string
		wantErr  string
	}{
		{
			name:     "basic key-value pairs",
			content:  "FOO=bar\nBAZ=qux\n",
			wantKeys: []string{"FOO", "BAZ"},
			wantVals: map[string]string{"FOO": "bar", "BAZ": "qux"},
		},
		{
			name:     "comments and blank lines",
			content:  "# This is a comment\n\nFOO=bar\n  # Indented comment\n\nBAZ=qux\n",
			wantKeys: []string{"FOO", "BAZ"},
			wantVals: map[string]string{"FOO": "bar", "BAZ": "qux"},
		},
		{
			name:     "values with hash kept verbatim",
			content:  "PASSWORD=abc#123\nURL=https://example.com#fragment\n",
			wantKeys: []string{"PASSWORD", "URL"},
			wantVals: map[string]string{"PASSWORD": "abc#123", "URL": "https://example.com#fragment"},
		},
		{
			name:     "quotes kept verbatim",
			content:  "FOO=\"bar baz\"\nBAR='single'\n",
			wantKeys: []string{"FOO", "BAR"},
			wantVals: map[string]string{"FOO": "\"bar baz\"", "BAR": "'single'"},
		},
		{
			name:     "empty value",
			content:  "FOO=\n",
			wantKeys: []string{"FOO"},
			wantVals: map[string]string{"FOO": ""},
		},
		{
			name:     "value with equals sign",
			content:  "CONNECTION=postgres://user:pass@host/db?opt=val\n",
			wantKeys: []string{"CONNECTION"},
			wantVals: map[string]string{"CONNECTION": "postgres://user:pass@host/db?opt=val"},
		},
		{
			name:     "duplicate keys last wins",
			content:  "FOO=first\nFOO=second\n",
			wantKeys: []string{"FOO"},
			wantVals: map[string]string{"FOO": "second"},
		},
		{
			name:     "empty file",
			content:  "",
			wantKeys: nil,
			wantVals: map[string]string{},
		},
		{
			name:     "only comments",
			content:  "# comment\n# another\n",
			wantKeys: nil,
			wantVals: map[string]string{},
		},
		{
			name:    "line without equals",
			content: "FOO=bar\nBADLINE\n",
			wantErr: "invalid line",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), ".env")
			if err := os.WriteFile(path, []byte(tt.content), 0644); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			gotVals, gotKeys, err := parseEnvFile(path)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("expected error containing %q, got: %v", tt.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if len(gotKeys) != len(tt.wantKeys) {
				t.Fatalf("keys = %v, want %v", gotKeys, tt.wantKeys)
			}
			for i, k := range gotKeys {
				if k != tt.wantKeys[i] {
					t.Errorf("keys[%d] = %q, want %q", i, k, tt.wantKeys[i])
				}
			}
			for k, want := range tt.wantVals {
				if got := gotVals[k]; got != want {
					t.Errorf("value[%q] = %q, want %q", k, got, want)
				}
			}
		})
	}
}

func TestParseEnvFile_NotFound(t *testing.T) {
	_, _, err := parseEnvFile("/nonexistent/path/.env")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
	if !strings.Contains(err.Error(), "opening env file") {
		t.Fatalf("expected 'opening env file' error, got: %v", err)
	}
}

func TestSecretsPush_FromFile(t *testing.T) {
	bin := buildAmika(t)
	envFile := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envFile, []byte("# API keys\nANTHROPIC_API_KEY=sk-ant-test-key-12345678\nOPENAI_API_KEY=sk-openai-test-key-12345678\n"), 0644); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	// Run with --from-file; it will display the secrets and prompt, then fail
	// because stdin is empty (no "y" confirmation). That's fine — we just
	// verify the parsing and display worked.
	cmd := exec.Command(bin, "secret", "push", "--from-file="+envFile)
	out, _ := cmd.CombinedOutput()
	text := string(out)
	if !strings.Contains(text, "ANTHROPIC_API_KEY") {
		t.Errorf("expected ANTHROPIC_API_KEY in output, got:\n%s", text)
	}
	if !strings.Contains(text, "OPENAI_API_KEY") {
		t.Errorf("expected OPENAI_API_KEY in output, got:\n%s", text)
	}
}

func TestSecretsPush_FromFileMissing(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secret", "push", "--from-file=/nonexistent/.env")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "opening env file") {
		t.Fatalf("expected 'opening env file' error, got:\n%s", out)
	}
}

func TestSecretsPush_FromFileBadLine(t *testing.T) {
	bin := buildAmika(t)
	envFile := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(envFile, []byte("GOOD=value\nBADLINE\n"), 0644); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	cmd := exec.Command(bin, "secret", "push", "--from-file="+envFile)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected non-zero exit code, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "invalid line") {
		t.Fatalf("expected 'invalid line' error, got:\n%s", out)
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

func TestCredentialTypeToAPI(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"OAuth", "oauth"},
		{"API Key", "api_key"},
		{"something else", "oauth"},
		{"", "oauth"},
	}
	for _, tt := range tests {
		got := credentialTypeToAPI(tt.input)
		if got != tt.want {
			t.Errorf("credentialTypeToAPI(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestSecretClaudePush_ValueFlag(t *testing.T) {
	bin := buildAmika(t)
	mockEnv := setupMockClaudeAPI(t)

	cmd := exec.Command(bin, "secret", "claude", "push",
		"--value", `{"claudeAiOauth":{"accessToken":"test"}}`,
		"--name", "Test OAuth")
	cmd.Env = mockEnv
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("expected success, got error: %v\n%s", err, out)
	}
	text := string(out)
	if strings.Contains(text, "must be valid JSON") {
		t.Fatalf("unexpected validation error for valid JSON:\n%s", text)
	}
}

func TestSecretClaudePush_InvalidOAuthJSON(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secret", "claude", "push",
		"--value", "not-json",
		"--type", "oauth",
		"--name", "Bad")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected error, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "OAuth credentials must be valid JSON") {
		t.Fatalf("expected JSON validation error, got:\n%s", out)
	}
}

func TestSecretClaudePush_APIKeyNoJSONValidation(t *testing.T) {
	bin := buildAmika(t)
	mockEnv := setupMockClaudeAPI(t)

	// api_key type should NOT require valid JSON — it should succeed.
	cmd := exec.Command(bin, "secret", "claude", "push",
		"--value", "sk-ant-api03-plaintext",
		"--type", "api_key",
		"--name", "My Key")
	cmd.Env = mockEnv
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("expected success, got error: %v\n%s", err, out)
	}
	text := string(out)
	if strings.Contains(text, "must be valid JSON") {
		t.Fatalf("api_key should not require JSON validation:\n%s", text)
	}
}

func TestSecretClaudePush_TypeAPIKeyReadsEnv(t *testing.T) {
	bin := buildAmika(t)

	// --type api_key without --value should read ANTHROPIC_API_KEY.
	// With the env var unset, it should produce an error.
	cmd := exec.Command(bin, "secret", "claude", "push",
		"--type", "api_key",
		"--name", "Key")
	cmd.Env = withEnv(os.Environ(), "ANTHROPIC_API_KEY=")
	// Filter out the env var entirely.
	var env []string
	for _, e := range cmd.Env {
		if !strings.HasPrefix(e, "ANTHROPIC_API_KEY=") {
			env = append(env, e)
		}
	}
	cmd.Env = env

	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected error, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "ANTHROPIC_API_KEY environment variable is not set") {
		t.Fatalf("expected ANTHROPIC_API_KEY error, got:\n%s", out)
	}
}

func TestSecretClaudePush_TypeAPIKeyWithEnvSet(t *testing.T) {
	bin := buildAmika(t)
	mockEnv := setupMockClaudeAPI(t)

	// With ANTHROPIC_API_KEY set, it should resolve the key and push successfully.
	cmd := exec.Command(bin, "secret", "claude", "push",
		"--type", "api_key",
		"--name", "Key From Env")
	cmd.Env = withEnv(mockEnv, "ANTHROPIC_API_KEY=sk-ant-api03-test")

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("expected success, got error: %v\n%s", err, out)
	}
	text := string(out)
	// Should NOT be a resolution error.
	if strings.Contains(text, "ANTHROPIC_API_KEY environment variable is not set") {
		t.Fatalf("unexpected resolution error when env var is set:\n%s", text)
	}
}

func TestSecretClaudePush_FromFile(t *testing.T) {
	bin := buildAmika(t)
	mockEnv := setupMockClaudeAPI(t)

	credFile := filepath.Join(t.TempDir(), "creds.json")
	if err := os.WriteFile(credFile, []byte(`{"claudeAiOauth":{"accessToken":"test"}}`), 0644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	cmd := exec.Command(bin, "secret", "claude", "push",
		"--from-file", credFile,
		"--name", "From File")
	cmd.Env = mockEnv
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("expected success, got error: %v\n%s", err, out)
	}
	text := string(out)
	// Should get past file reading and validation.
	if strings.Contains(text, "reading credentials file") {
		t.Fatalf("unexpected file read error:\n%s", text)
	}
	if strings.Contains(text, "must be valid JSON") {
		t.Fatalf("unexpected validation error:\n%s", text)
	}
}

func TestSecretClaudePush_FromFileMissing(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secret", "claude", "push",
		"--from-file", "/nonexistent/creds.json",
		"--name", "Missing")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected error, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "reading credentials file") {
		t.Fatalf("expected file read error, got:\n%s", out)
	}
}

func TestSecretClaudeList_WithMock(t *testing.T) {
	bin := buildAmika(t)
	mockEnv := setupMockClaudeAPI(t)

	cmd := exec.Command(bin, "secret", "claude", "list")
	cmd.Env = mockEnv
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("unexpected error:\n%s", out)
	}
	// Should not panic or give unexpected errors.
	text := string(out)
	if strings.Contains(text, "panic") {
		t.Fatalf("unexpected panic:\n%s", text)
	}
}

func TestSecretClaudeDelete_NoArgs(t *testing.T) {
	bin := buildAmika(t)

	cmd := exec.Command(bin, "secret", "claude", "delete")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected error, got success\noutput:\n%s", out)
	}
	if !strings.Contains(string(out), "accepts 1 arg(s)") {
		t.Fatalf("expected args error, got:\n%s", out)
	}
}

func TestSecretClaudePluralAlias(t *testing.T) {
	bin := buildAmika(t)
	mockEnv := setupMockClaudeAPI(t)

	// "secrets claude list" should also work.
	cmd := exec.Command(bin, "secrets", "claude", "list")
	cmd.Env = mockEnv
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("unexpected error:\n%s", out)
	}
	text := string(out)
	if strings.Contains(text, "unknown command") {
		t.Fatalf("secrets plural alias not working:\n%s", text)
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

// setupMockClaudeAPI starts a mock API server for Claude secret endpoints
// and returns an environment slice (based on os.Environ) that directs the
// CLI at the mock. The server is closed automatically when the test ends.
//
// TODO: extract mock API server helpers to a shared test package (e.g. test/testutil).
func setupMockClaudeAPI(t *testing.T) []string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/secrets/claude":
			json.NewEncoder(w).Encode(map[string]string{
				"id":    "cred-test-123",
				"name":  "Test",
				"scope": "user",
			})
		case r.Method == "GET" && r.URL.Path == "/api/secrets/claude":
			json.NewEncoder(w).Encode([]interface{}{})
		case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/secrets/"):
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return withEnv(os.Environ(),
		"AMIKA_API_URL="+srv.URL,
		"AMIKA_API_KEY=test-bearer-token",
	)
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
