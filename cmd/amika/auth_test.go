package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofixpoint/amika/internal/auth"
)

func TestAuthLogin_APIKeyFile(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}

	out, err := runRootCommand("auth", "login", "--api-key-file", keyPath)
	if err != nil {
		t.Fatalf("login: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "Stored API key") {
		t.Fatalf("unexpected output: %q", out)
	}

	loaded, err := auth.LoadAPIKey()
	if err != nil {
		t.Fatalf("LoadAPIKey: %v", err)
	}
	if loaded == nil || loaded.Key != "sk_abc" {
		t.Fatalf("loaded = %+v, want sk_abc", loaded)
	}
}

func TestAuthLogin_RefusesWhenAlreadyLoggedIn(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "existing"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_new\n"), 0600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	out, err := runRootCommand("auth", "login", "--api-key-file", keyPath)
	if err == nil {
		t.Fatalf("expected error, got output %q", out)
	}
	if !strings.Contains(err.Error(), "already have") {
		t.Fatalf("unexpected error: %v", err)
	}

	loaded, _ := auth.LoadAPIKey()
	if loaded == nil || loaded.Key != "existing" {
		t.Fatalf("stored key should be unchanged: %+v", loaded)
	}
}

func TestAuthLogout_RecoversFromCorruptFiles(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	// Write garbage where each credential file is expected. Logout must
	// still succeed so the user can recover and log back in.
	if err := os.WriteFile(filepath.Join(stateDir, "api-key.json"), []byte("not json"), 0600); err != nil {
		t.Fatalf("write corrupt api key: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "workos-session.json"), []byte("{"), 0600); err != nil {
		t.Fatalf("write corrupt session: %v", err)
	}

	out, err := runRootCommand("auth", "logout")
	if err != nil {
		t.Fatalf("logout: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "stored API key file is unreadable") {
		t.Fatalf("missing api key warning: %q", out)
	}
	if !strings.Contains(out, "stored session file is unreadable") {
		t.Fatalf("missing session warning: %q", out)
	}

	for _, name := range []string{"api-key.json", "workos-session.json"} {
		if _, err := os.Stat(filepath.Join(stateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still present after logout: err=%v", name, err)
		}
	}

	// Subsequent login should succeed — recovery is complete.
	keyPath := filepath.Join(t.TempDir(), "k")
	if err := os.WriteFile(keyPath, []byte("sk_recovered\n"), 0600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	if _, err := runRootCommand("auth", "login", "--api-key-file", keyPath); err != nil {
		t.Fatalf("login after recovery: %v", err)
	}
}

func TestAuthLogin_SurfacesUnderlyingIOError(t *testing.T) {
	// Point AMIKA_STATE_DIRECTORY at a path that exists as a file so
	// ReadFile fails with ENOTDIR — a non-corruption error that
	// `auth logout` cannot fix, so login must surface it directly
	// instead of redirecting to logout.
	notADir := filepath.Join(t.TempDir(), "state")
	if err := os.WriteFile(notADir, []byte("not a dir"), 0600); err != nil {
		t.Fatalf("write blocker file: %v", err)
	}
	t.Setenv("AMIKA_STATE_DIRECTORY", notADir)
	t.Setenv("AMIKA_API_KEY", "")

	keyPath := filepath.Join(t.TempDir(), "k")
	if err := os.WriteFile(keyPath, []byte("sk_x\n"), 0600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	_, err := runRootCommand("auth", "login", "--api-key-file", keyPath)
	if err == nil {
		t.Fatal("expected I/O error")
	}
	if strings.Contains(err.Error(), "amika auth logout") {
		t.Fatalf("should not redirect to logout for I/O error: %v", err)
	}
	if !strings.Contains(err.Error(), "reading stored") {
		t.Fatalf("error should name the failing operation: %v", err)
	}
}

func TestAuthLogin_RedirectsToLogoutOnCorruptFile(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	if err := os.WriteFile(filepath.Join(stateDir, "api-key.json"), []byte("garbage"), 0600); err != nil {
		t.Fatalf("write corrupt api key: %v", err)
	}

	keyPath := filepath.Join(t.TempDir(), "k")
	if err := os.WriteFile(keyPath, []byte("sk_new\n"), 0600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	_, err := runRootCommand("auth", "login", "--api-key-file", keyPath)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "amika auth logout") {
		t.Fatalf("error should point at logout: %v", err)
	}
}

func TestAuthLogout_ClearsBoth(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "k"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	out, err := runRootCommand("auth", "logout")
	if err != nil {
		t.Fatalf("logout: %v", err)
	}
	if !strings.Contains(out, "Cleared stored API key") {
		t.Fatalf("unexpected output: %q", out)
	}

	out, err = runRootCommand("auth", "logout")
	if err != nil {
		t.Fatalf("idempotent logout: %v", err)
	}
	if !strings.Contains(out, "Already logged out") {
		t.Fatalf("second logout output: %q", out)
	}
}

func TestAuthStatus_EnvShadowsStoredKey(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "env_key")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "stored"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(out, "Authenticated via AMIKA_API_KEY") {
		t.Fatalf("missing env line: %q", out)
	}
	if !strings.Contains(out, "shadows stored API key") {
		t.Fatalf("missing shadow line: %q", out)
	}
}

func TestAuthStatus_StoredKeyReported(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "stored"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(out, "Authenticated via stored API key") {
		t.Fatalf("unexpected status: %q", out)
	}
}

func TestAuthStatus_EnvWinsWhenSessionCorrupt(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "env_key")

	if err := os.WriteFile(filepath.Join(stateDir, "workos-session.json"), []byte("{"), 0600); err != nil {
		t.Fatalf("write corrupt session: %v", err)
	}

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "Authenticated via AMIKA_API_KEY") {
		t.Fatalf("env winner line missing: %q", out)
	}
	if !strings.Contains(out, "ignoring unreadable session file") {
		t.Fatalf("shadow warning missing: %q", out)
	}
}

func TestAuthStatus_StoredKeyWinsWhenSessionCorrupt(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	if err := auth.SaveAPIKey(auth.APIKeyAuth{Key: "stored"}); err != nil {
		t.Fatalf("SaveAPIKey: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "workos-session.json"), []byte("{"), 0600); err != nil {
		t.Fatalf("write corrupt session: %v", err)
	}

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "Authenticated via stored API key") {
		t.Fatalf("stored key winner missing: %q", out)
	}
	if !strings.Contains(out, "ignoring unreadable session file") {
		t.Fatalf("shadow warning missing: %q", out)
	}
}

func TestAuthStatus_SessionWinsWithCorruptAPIKey(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	if err := os.WriteFile(filepath.Join(stateDir, "api-key.json"), []byte("not json"), 0600); err != nil {
		t.Fatalf("write corrupt api key: %v", err)
	}
	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "tok",
		Email:       "sess@example.com",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "Logged in as sess@example.com") {
		t.Fatalf("session winner missing: %q", out)
	}
	if !strings.Contains(out, "ignoring unreadable API key file") {
		t.Fatalf("api key warning missing: %q", out)
	}
}

func TestAuthStatus_OnlyCorruptFile(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")

	if err := os.WriteFile(filepath.Join(stateDir, "workos-session.json"), []byte("{"), 0600); err != nil {
		t.Fatalf("write corrupt session: %v", err)
	}

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "Stored session file is unreadable") {
		t.Fatalf("expected unreadable warning: %q", out)
	}
	if !strings.Contains(out, "amika auth logout") {
		t.Fatalf("expected recovery hint: %q", out)
	}
	if strings.Contains(out, "Not logged in") {
		t.Fatalf("should not say 'Not logged in' when a corrupt file is present: %q", out)
	}
}

func TestAuthStatus_NotLoggedIn(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	out, err := runRootCommand("auth", "status")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !strings.Contains(out, "Not logged in") {
		t.Fatalf("unexpected status: %q", out)
	}
}
