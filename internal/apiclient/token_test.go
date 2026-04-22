package apiclient

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofixpoint/amika/internal/auth"
)

func TestResolvedTokenSource_PrecedenceEnvWins(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "env_key")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "file_key"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	tok, err := NewResolvedTokenSource("client").Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "env_key" {
		t.Fatalf("got %q, want env_key", tok)
	}
}

func TestResolvedTokenSource_PrecedenceFileOverSession(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "file_key"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}
	// Save a session that would otherwise be used; the file key should win.
	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "session_token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	tok, err := NewResolvedTokenSource("client").Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "file_key" {
		t.Fatalf("got %q, want file_key", tok)
	}
}

func TestResolvedTokenSource_FallsBackToSession(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "session_token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	tok, err := NewResolvedTokenSource("client").Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "session_token" {
		t.Fatalf("got %q, want session_token", tok)
	}
}

func TestResolvedTokenSource_CorruptAPIKeyFallsBackToSession(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	// Corrupt API key file — must not block fall-through to the session.
	if err := os.WriteFile(filepath.Join(stateDir, "api-key.json"), []byte("not json"), 0600); err != nil {
		t.Fatalf("write corrupt api key: %v", err)
	}
	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "session_token",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	tok, err := NewResolvedTokenSource("client").Token()
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "session_token" {
		t.Fatalf("got %q, want session_token", tok)
	}
}

func TestResolvedTokenSource_CorruptAPIKeyNoSessionMentionsBoth(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	if err := os.WriteFile(filepath.Join(stateDir, "api-key.json"), []byte("not json"), 0600); err != nil {
		t.Fatalf("write corrupt api key: %v", err)
	}

	_, err := NewResolvedTokenSource("client").Token()
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("error should mention unreadable API key: %v", err)
	}
}

func TestResolvedTokenSource_NoCredentials(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if _, err := NewResolvedTokenSource("client").Token(); err == nil {
		t.Fatal("expected error when no credentials present")
	}
}

func TestResolvedTokenSource_ReresolvesOnEachCall(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	src := NewResolvedTokenSource("client")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "first"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}
	tok, err := src.Token()
	if err != nil || tok != "first" {
		t.Fatalf("first Token = (%q, %v), want (first, nil)", tok, err)
	}

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "second"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}
	tok, err = src.Token()
	if err != nil || tok != "second" {
		t.Fatalf("second Token = (%q, %v), want (second, nil)", tok, err)
	}
}
