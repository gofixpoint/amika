package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/auth"
)

func TestAuthLogin_APIKeyFile(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	// A successful login writes the managed SSH config, so HOME has to be
	// redirected or the test would edit the developer's own ~/.ssh.
	t.Setenv("HOME", t.TempDir())

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

func TestAuthLogin_APIKeyFileIgnoresStoredSession(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	t.Setenv("HOME", t.TempDir())

	// A stored session — valid or not — must not block API-key login.
	// runmode.DefaultAuthChecker resolves API keys ahead of sessions, so they
	// never conflict; and this path is documented to stay reliably
	// non-interactive (no network, no session validation), which is
	// load-bearing for CI/offline recovery.
	if err := auth.SaveSession(auth.WorkOSSession{
		AccessToken: "tok",
		Email:       "user@example.com",
		ExpiresAt:   time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_new\n"), 0600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	out, err := runRootCommand("auth", "login", "--api-key-file", keyPath)
	if err != nil {
		t.Fatalf("api-key login should ignore stored session: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "Stored API key") {
		t.Fatalf("login did not store the new API key: %q", out)
	}

	loaded, err := auth.LoadAPIKey()
	if err != nil {
		t.Fatalf("LoadAPIKey: %v", err)
	}
	if loaded == nil || loaded.Key != "sk_new" {
		t.Fatalf("api key not stored: %+v", loaded)
	}
}

func TestAuthLogout_RecoversFromCorruptFiles(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)
	t.Setenv("AMIKA_API_KEY", "")
	// The recovery login at the end writes the managed SSH config.
	t.Setenv("HOME", t.TempDir())

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

// A login has to leave a usable SSH host block behind, so a user whose public
// key was uploaded through the web UI — and who therefore never runs
// `secret ssh-keygen` — can still reach a sandbox.
func TestAuthLogin_WritesManagedSSHSessionBlock(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	t.Setenv("AMIKA_API_URL", "https://app.amika.dev")
	home := t.TempDir()
	t.Setenv("HOME", home)

	// Pin the ProxyCommand: without an override it names the test binary.
	binaryPath := writeStandInBinary(t)
	t.Setenv("AMIKA_BINARY_PATH", binaryPath)

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	if out, err := runRootCommandOutput(t, "auth", "login", "--api-key-file", keyPath); err != nil {
		t.Fatalf("login: %v (out=%q)", err, out)
	}

	conf, err := os.ReadFile(filepath.Join(home, ".ssh", "amika.conf"))
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	want := "Host *.app-amika-dev.amika\n" +
		"  User amika\n" +
		"  IdentityFile " + filepath.Join(home, ".ssh", "amika_id_ed25519") + "\n" +
		"  IdentitiesOnly yes\n" +
		"  StrictHostKeyChecking yes\n" +
		"  UserKnownHostsFile " + filepath.Join(home, ".ssh", "amika_known_hosts") + "\n" +
		"  ProxyCommand " + binaryPath + " plumbing ssh-stdio-proxy %h\n" +
		"  ServerAliveInterval 15\n" +
		"  ServerAliveCountMax 3\n"
	if !strings.Contains(string(conf), want) {
		t.Fatalf("amika.conf missing the session block:\nwant:\n%s\ngot:\n%s", want, conf)
	}

	sshConfig, err := os.ReadFile(filepath.Join(home, ".ssh", "config"))
	if err != nil {
		t.Fatalf("read ssh config: %v", err)
	}
	if !strings.Contains(string(sshConfig), "Include amika.conf") {
		t.Fatalf("~/.ssh/config missing the Include line:\n%s", sshConfig)
	}
}

// The credential is already stored by the time the SSH config is written, so a
// config that cannot be written must warn rather than report the login as
// failed. Every command that needs the block rewrites it on use anyway.
func TestAuthLogin_WarnsButSucceedsWhenSSHConfigCannotBeWritten(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	// A relative override cannot be embedded in a ProxyCommand, so resolving
	// the session config fails before anything is written.
	t.Setenv("AMIKA_BINARY_PATH", "relative/amika")

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	out, err := runRootCommandOutput(t, "auth", "login", "--api-key-file", keyPath)
	if err != nil {
		t.Fatalf("login must still succeed: %v (out=%q)", err, out)
	}
	if !strings.Contains(out, "could not update the managed SSH config") {
		t.Errorf("no warning about the unwritable SSH config: %q", out)
	}
	if !strings.Contains(out, "Stored API key") {
		t.Errorf("login did not report success: %q", out)
	}

	loaded, loadErr := auth.LoadAPIKey()
	if loadErr != nil || loaded == nil || loaded.Key != "sk_abc" {
		t.Fatalf("api key not stored: %+v (%v)", loaded, loadErr)
	}
}

// `~/.ssh/config` governs every SSH connection the machine makes, and it is
// often a symlink into a dotfiles repo, so a login that edits it has to say
// which files it touched.
func TestAuthLogin_NamesTheSSHFilesItTouched(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AMIKA_BINARY_PATH", writeStandInBinary(t))

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	out, err := runRootCommandOutput(t, "auth", "login", "--api-key-file", keyPath)
	if err != nil {
		t.Fatalf("login: %v (out=%q)", err, out)
	}
	for _, want := range []string{
		filepath.Join(home, ".ssh", "amika.conf"),
		filepath.Join(home, ".ssh", "config"),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("login did not disclose %q: %q", want, out)
		}
	}
}

// The block names an identity whether or not one exists. Saying so at login
// beats letting the first `sandbox ssh` be where the user finds out, and the
// --import route has to be offered because a UI-uploaded key already has a
// private half that only --import points the config at.
func TestAuthLogin_HintsBothFixesWhenNoIdentityExists(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AMIKA_BINARY_PATH", writeStandInBinary(t))

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	out, err := runRootCommandOutput(t, "auth", "login", "--api-key-file", keyPath)
	if err != nil {
		t.Fatalf("login: %v (out=%q)", err, out)
	}
	for _, want := range []string{
		"No SSH identity at",
		"amika secret ssh-keygen",
		"--import",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("login output missing %q: %q", want, out)
		}
	}
}

// With an identity in place there is nothing to fix, so the hint must not
// fire — an unconditional warning trains users to ignore it.
func TestAuthLogin_NoIdentityHintWhenOneExists(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AMIKA_BINARY_PATH", writeStandInBinary(t))

	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatalf("mkdir .ssh: %v", err)
	}
	identity := filepath.Join(home, ".ssh", "amika_id_ed25519")
	if err := os.WriteFile(identity, []byte("key material\n"), 0o600); err != nil {
		t.Fatalf("write identity: %v", err)
	}

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	out, err := runRootCommandOutput(t, "auth", "login", "--api-key-file", keyPath)
	if err != nil {
		t.Fatalf("login: %v (out=%q)", err, out)
	}
	if strings.Contains(out, "No SSH identity at") {
		t.Errorf("hint fired despite an identity being present: %q", out)
	}
}

// In JSON mode stdout carries only the JSON value, so neither the disclosure
// nor the hint may leak into it.
func TestAuthLoginJSON_KeepsStdoutASingleJSONValue(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AMIKA_BINARY_PATH", writeStandInBinary(t))

	keyPath := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyPath, []byte("sk_abc\n"), 0600); err != nil {
		t.Fatalf("write key file: %v", err)
	}
	out, err := runRootCommandOutput(t, "auth", "login", "--api-key-file", keyPath, "-o", "json")
	if err != nil {
		t.Fatalf("login: %v (out=%q)", err, out)
	}
	var status authStatusJSON
	if jsonErr := json.Unmarshal([]byte(out), &status); jsonErr != nil {
		t.Fatalf("stdout is not a single JSON value (%v): %q", jsonErr, out)
	}
	if !status.Authenticated || status.Method != "stored_api_key" {
		t.Errorf("unexpected status: %+v", status)
	}
}

// writeStandInBinary creates a file that passes the ProxyCommand path checks,
// so the rendered config does not name the test binary.
func writeStandInBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "amika")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write stand-in binary: %v", err)
	}
	return path
}
