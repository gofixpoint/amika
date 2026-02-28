package auth

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestDiscover_ClaudeAPIPathAndFieldOrder(t *testing.T) {
	home := t.TempDir()

	writeDiscoveryFixture(t, filepath.Join(home, ".claude.json.api"), `{"apiKey":"not-anthropic"}`)
	writeDiscoveryFixture(t, filepath.Join(home, ".claude.json"), `{"primaryApiKey":"","apiKey":"sk-ant-file2","anthropicApiKey":"sk-ant-file2-alt"}`)

	result, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error: %v", err)
	}
	if result.Anthropic != "sk-ant-file2" {
		t.Fatalf("Anthropic = %q, want %q", result.Anthropic, "sk-ant-file2")
	}
}

func TestDiscover_ClaudeOAuthExpiryAndNoOAuth(t *testing.T) {
	home := t.TempDir()
	future := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	past := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)

	writeDiscoveryFixture(t, filepath.Join(home, ".claude-oauth-credentials.json"), `{"claudeAiOauth":{"accessToken":"oauth-live","expiresAt":"`+future+`"}}`)

	withOAuth, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error: %v", err)
	}
	if withOAuth.Anthropic != "oauth-live" {
		t.Fatalf("Anthropic oauth = %q, want %q", withOAuth.Anthropic, "oauth-live")
	}

	noOAuth, err := Discover(Options{HomeDir: home, IncludeOAuth: false})
	if err != nil {
		t.Fatalf("Discover() unexpected error with no oauth: %v", err)
	}
	if noOAuth.Anthropic != "" {
		t.Fatalf("Anthropic with no oauth = %q, want empty", noOAuth.Anthropic)
	}

	writeDiscoveryFixture(t, filepath.Join(home, ".claude-oauth-credentials.json"), `{"claudeAiOauth":{"accessToken":"oauth-expired","expiresAt":"`+past+`"}}`)
	expired, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error with expired oauth: %v", err)
	}
	if expired.Anthropic != "" {
		t.Fatalf("Anthropic with expired oauth = %q, want empty", expired.Anthropic)
	}
}

func TestDiscover_CodexPrefersAPIOverOAuth(t *testing.T) {
	home := t.TempDir()
	writeDiscoveryFixture(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"codex-api","tokens":{"access_token":"codex-oauth"}}`)

	result, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error: %v", err)
	}
	if result.OpenAI != "codex-api" {
		t.Fatalf("OpenAI = %q, want %q", result.OpenAI, "codex-api")
	}
}

func TestDiscover_OpenCodeParsingAndExpiry(t *testing.T) {
	home := t.TempDir()
	future := time.Now().Add(2 * time.Hour).UnixMilli()
	past := time.Now().Add(-2 * time.Hour).UnixMilli()

	writeDiscoveryFixture(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), `{
		"anthropic": {"type": "api", "key": "op-anth"},
		"openai": {"type": "oauth", "access": "op-open", "expires": `+itoa(future)+`},
		"groq": {"type": "api", "key": "op-groq"},
		"xai": {"type": "oauth", "access": "expired", "expires": `+itoa(past)+`}
	}`)

	result, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error: %v", err)
	}
	if result.Anthropic != "op-anth" {
		t.Fatalf("Anthropic = %q, want %q", result.Anthropic, "op-anth")
	}
	if result.OpenAI != "op-open" {
		t.Fatalf("OpenAI = %q, want %q", result.OpenAI, "op-open")
	}
	if result.Other == nil || result.Other["groq"] != "op-groq" {
		t.Fatalf("Other.groq = %q, want %q", result.Other["groq"], "op-groq")
	}
	if _, ok := result.Other["xai"]; ok {
		t.Fatal("expected expired xai oauth to be ignored")
	}
}

func TestDiscover_AmpFieldOrder(t *testing.T) {
	home := t.TempDir()
	writeDiscoveryFixture(t, filepath.Join(home, ".amp", "config.json"), `{
		"token": "amp-token",
		"anthropic_api_key": "amp-anth-priority"
	}`)

	result, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error: %v", err)
	}
	if result.Anthropic != "amp-anth-priority" {
		t.Fatalf("Anthropic = %q, want %q", result.Anthropic, "amp-anth-priority")
	}
}

func TestDiscover_PriorityResolution(t *testing.T) {
	home := t.TempDir()
	future := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)

	writeDiscoveryFixture(t, filepath.Join(home, ".amp", "config.json"), `{"token":"amp-token"}`)
	writeDiscoveryFixture(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), `{"anthropic":{"type":"api","key":"op-anth"},"openai":{"type":"api","key":"op-open"}}`)
	writeDiscoveryFixture(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"codex-open"}`)
	writeDiscoveryFixture(t, filepath.Join(home, ".claude-oauth-credentials.json"), `{"claudeAiOauth":{"accessToken":"claude-oauth","expiresAt":"`+future+`"}}`)
	writeDiscoveryFixture(t, filepath.Join(home, ".claude.json"), `{"apiKey":"sk-ant-claude-api"}`)

	result, err := Discover(Options{HomeDir: home, IncludeOAuth: true})
	if err != nil {
		t.Fatalf("Discover() unexpected error: %v", err)
	}
	if result.Anthropic != "sk-ant-claude-api" {
		t.Fatalf("Anthropic = %q, want %q", result.Anthropic, "sk-ant-claude-api")
	}
	if result.OpenAI != "codex-open" {
		t.Fatalf("OpenAI = %q, want %q", result.OpenAI, "codex-open")
	}
}

func TestDiscover_ParseErrors(t *testing.T) {
	t.Run("malformed_json", func(t *testing.T) {
		home := t.TempDir()
		writeDiscoveryFixture(t, filepath.Join(home, ".claude.json"), `{not-json}`)
		if _, err := Discover(Options{HomeDir: home, IncludeOAuth: true}); err == nil {
			t.Fatal("expected error, got nil")
		}
	})

	t.Run("invalid_oauth_expiry", func(t *testing.T) {
		home := t.TempDir()
		writeDiscoveryFixture(t, filepath.Join(home, ".claude-oauth-credentials.json"), `{"claudeAiOauth":{"accessToken":"x","expiresAt":"not-rfc3339"}}`)
		if _, err := Discover(Options{HomeDir: home, IncludeOAuth: true}); err == nil {
			t.Fatal("expected error, got nil")
		}
	})

	t.Run("invalid_opencode_expires", func(t *testing.T) {
		home := t.TempDir()
		writeDiscoveryFixture(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), `{"openai":{"type":"oauth","access":"x","expires":"bad"}}`)
		if _, err := Discover(Options{HomeDir: home, IncludeOAuth: true}); err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}

func writeDiscoveryFixture(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("failed to create fixture dir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write fixture %s: %v", path, err)
	}
}

func itoa(v int64) string {
	return strconv.FormatInt(v, 10)
}
