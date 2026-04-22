package sandboxcmd

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gofixpoint/amika/internal/auth"
)

func TestDefaultAuthChecker_EnvKeySatisfies(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "env_key")

	if err := defaultAuthChecker(); err != nil {
		t.Fatalf("defaultAuthChecker: %v", err)
	}
}

func TestDefaultAuthChecker_StoredAPIKeySatisfies(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "stored"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}
	if err := defaultAuthChecker(); err != nil {
		t.Fatalf("defaultAuthChecker: %v", err)
	}
}

func TestDefaultAuthChecker_SessionSatisfies(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	if err := defaultAuthChecker(); err != nil {
		t.Fatalf("defaultAuthChecker: %v", err)
	}
}

func TestDefaultAuthChecker_CorruptAPIKeyFallsThroughToSession(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	// Corrupt higher-priority API key file must not block a valid session.
	if err := os.WriteFile(filepath.Join(stateDir, "api-key.json"), []byte("not json"), 0600); err != nil {
		t.Fatalf("write corrupt api key: %v", err)
	}
	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "tok",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	if err := defaultAuthChecker(); err != nil {
		t.Fatalf("defaultAuthChecker should tolerate corrupt API key: %v", err)
	}
}

func TestDefaultAuthChecker_NoCredentials(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := defaultAuthChecker(); err == nil {
		t.Fatal("expected error when no credentials present")
	}
}
