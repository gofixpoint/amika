package basedir

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPaths_DefaultsFromHomeOverride(t *testing.T) {
	home := t.TempDir()
	p := New(home)

	configHome, _ := p.ConfigHome()
	if configHome != filepath.Join(home, ".config") {
		t.Fatalf("ConfigHome = %q", configHome)
	}

	dataHome, _ := p.DataHome()
	if dataHome != filepath.Join(home, ".local", "share") {
		t.Fatalf("DataHome = %q", dataHome)
	}

	cacheHome, _ := p.CacheHome()
	if cacheHome != filepath.Join(home, ".cache") {
		t.Fatalf("CacheHome = %q", cacheHome)
	}

	stateHome, _ := p.StateHome()
	if stateHome != filepath.Join(home, ".local", "state") {
		t.Fatalf("StateHome = %q", stateHome)
	}
}

func TestPaths_XDGOverrides(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(t.TempDir(), "cfg")
	data := filepath.Join(t.TempDir(), "data")
	cache := filepath.Join(t.TempDir(), "cache")
	state := filepath.Join(t.TempDir(), "state")

	setEnv(t, envXDGConfigHome, config)
	setEnv(t, envXDGDataHome, data)
	setEnv(t, envXDGCacheHome, cache)
	setEnv(t, envXDGStateHome, state)

	p := New(home)

	if got, _ := p.AuthEnvCacheFile(); got != filepath.Join(cache, "amika", "env-cache.json") {
		t.Fatalf("AuthEnvCacheFile = %q", got)
	}
	if got, _ := p.AuthKeychainFile(); got != filepath.Join(data, "amika", "keychain.json") {
		t.Fatalf("AuthKeychainFile = %q", got)
	}
	if got, _ := p.AuthOAuthFile(); got != filepath.Join(state, "amika", "oauth.json") {
		t.Fatalf("AuthOAuthFile = %q", got)
	}
	if got, _ := p.MountsStateFile(); got != filepath.Join(state, "amika", "mounts.jsonl") {
		t.Fatalf("MountsStateFile = %q", got)
	}
	if got, _ := p.SandboxesStateFile(); got != filepath.Join(state, "amika", "sandboxes.jsonl") {
		t.Fatalf("SandboxesStateFile = %q", got)
	}
}

func TestStateFileHelpers(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state", "amika")

	if got := MountsStateFileIn(stateDir); got != filepath.Join(stateDir, "mounts.jsonl") {
		t.Fatalf("MountsStateFileIn = %q", got)
	}
	if got := SandboxesStateFileIn(stateDir); got != filepath.Join(stateDir, "sandboxes.jsonl") {
		t.Fatalf("SandboxesStateFileIn = %q", got)
	}
}

func setEnv(t *testing.T, key, value string) {
	t.Helper()
	orig, had := os.LookupEnv(key)
	if err := os.Setenv(key, value); err != nil {
		t.Fatalf("Setenv(%s): %v", key, err)
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, orig)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}
