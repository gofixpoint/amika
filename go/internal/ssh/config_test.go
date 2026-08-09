package ssh

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/config"
)

func TestAlias(t *testing.T) {
	if got := Alias("sb_1"); got != "amika-sb_1" {
		t.Fatalf("Alias = %q", got)
	}
}

func TestParseDestination(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		wantUser    string
		wantHost    string
		wantPort    int
		wantOptions []string
		wantErr     bool
	}{
		{name: "user@host", in: "token@ssh.app.daytona.io", wantUser: "token", wantHost: "ssh.app.daytona.io"},
		{name: "with port", in: "-p 2222 user@host", wantUser: "user", wantHost: "host", wantPort: 2222},
		{name: "attached port", in: "-p2222 user@host", wantUser: "user", wantHost: "host", wantPort: 2222},
		{name: "host only", in: "host", wantHost: "host"},
		{name: "boolean flag preserved", in: "-4 token@host", wantUser: "token", wantHost: "host", wantOptions: []string{"-4"}},
		{name: "identity and option preserved", in: "-i /key -o Compression=yes user@host", wantUser: "user", wantHost: "host", wantOptions: []string{"-i", "/key", "-o", "Compression=yes"}},
		{name: "port not counted as option", in: "-i /key -p 2222 user@host", wantUser: "user", wantHost: "host", wantPort: 2222, wantOptions: []string{"-i", "/key"}},
		{name: "uppercase -P tag consumes its argument", in: "-P mytag user@host", wantUser: "user", wantHost: "host", wantOptions: []string{"-P", "mytag"}},
		{name: "uppercase -P tag alongside lowercase -p port", in: "-P mytag -p 2222 user@host", wantUser: "user", wantHost: "host", wantPort: 2222, wantOptions: []string{"-P", "mytag"}},
		{name: "login flag parsed as user, not an option", in: "-l token host", wantUser: "token", wantHost: "host"},
		{name: "attached login flag", in: "-ltoken host", wantUser: "token", wantHost: "host"},
		{name: "login flag takes precedence over user@host", in: "-l token bar@host", wantUser: "token", wantHost: "host"},
		{name: "missing login value", in: "-l", wantErr: true},
		{name: "empty", in: "", wantErr: true},
		{name: "bad port", in: "-p notanumber user@host", wantErr: true},
		{name: "missing port value", in: "-p", wantErr: true},
		{name: "more than one host", in: "a@host1 b@host2", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseDestination(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q", tt.in)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseDestination(%q): %v", tt.in, err)
			}
			if got.User != tt.wantUser || got.Host != tt.wantHost || got.Port != tt.wantPort {
				t.Fatalf("got %+v, want user=%q host=%q port=%d", got, tt.wantUser, tt.wantHost, tt.wantPort)
			}
			if !reflect.DeepEqual(got.Options, tt.wantOptions) {
				t.Fatalf("got options %#v, want %#v", got.Options, tt.wantOptions)
			}
		})
	}
}

func TestNewHostEntry(t *testing.T) {
	entry, err := NewHostEntry("sb_1", "my-sandbox", "-p 2222 token@ssh.app.daytona.io", "2026-06-04T18:30:00.000Z")
	if err != nil {
		t.Fatalf("NewHostEntry: %v", err)
	}
	want := HostEntry{
		SandboxID:   "sb_1",
		SandboxName: "my-sandbox",
		HostName:    "ssh.app.daytona.io",
		User:        "token",
		Port:        2222,
		ExpiresAt:   "2026-06-04T18:30:00.000Z",
	}
	if entry != want {
		t.Fatalf("entry = %+v, want %+v", entry, want)
	}
}

func TestNewHostEntryRejectsEmptyDestination(t *testing.T) {
	if _, err := NewHostEntry("sb_1", "n", "", ""); err == nil {
		t.Fatal("expected error for empty destination")
	}
}

func TestRender(t *testing.T) {
	state := HostsState{Hosts: []HostEntry{
		{SandboxID: "sb_1", SandboxName: "my-sandbox", HostName: "ssh.app.daytona.io", User: "token"},
	}}
	want := managedHeader + "\n# my-sandbox\nHost amika-sb_1\n  HostName ssh.app.daytona.io\n  User token\n  StrictHostKeyChecking accept-new\n"
	if got := Render(state); got != want {
		t.Fatalf("Render mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestRenderIncludesPortAndNameComment(t *testing.T) {
	state := HostsState{Hosts: []HostEntry{
		{SandboxID: "sb_2", SandboxName: "named", HostName: "h", User: "u", Port: 2222},
	}}
	got := Render(state)
	if !strings.Contains(got, "  Port 2222\n") {
		t.Errorf("expected Port line, got:\n%s", got)
	}
	nameIdx := strings.Index(got, "# named")
	hostIdx := strings.Index(got, "Host amika-sb_2")
	if nameIdx < 0 || hostIdx < 0 || nameIdx > hostIdx {
		t.Errorf("name comment should precede the Host line, got:\n%s", got)
	}
}

func TestStateRoundTrip(t *testing.T) {
	paths := testPaths(t)
	if got, err := LoadState(paths); err != nil || len(got.Hosts) != 0 {
		t.Fatalf("LoadState empty: got %+v err %v", got, err)
	}

	state := HostsState{Hosts: []HostEntry{{SandboxID: "sb_1", SandboxName: "n", HostName: "h", User: "u"}}}
	if err := SaveState(paths, state); err != nil {
		t.Fatalf("SaveState: %v", err)
	}

	loaded, err := LoadState(paths)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if len(loaded.Hosts) != 1 || loaded.Hosts[0].SandboxID != "sb_1" {
		t.Fatalf("round trip mismatch: %+v", loaded)
	}

	statePath, _ := paths.SSHHostsStateFile()
	assertPerm(t, statePath, 0o600)
}

func TestUpsertReplacesAndSorts(t *testing.T) {
	state := HostsState{}
	state.Upsert(HostEntry{SandboxID: "sb_b", HostName: "old"})
	state.Upsert(HostEntry{SandboxID: "sb_a", HostName: "a"})
	state.Upsert(HostEntry{SandboxID: "sb_b", HostName: "new"})

	if len(state.Hosts) != 2 {
		t.Fatalf("expected 2 hosts, got %d", len(state.Hosts))
	}
	if state.Hosts[0].SandboxID != "sb_a" || state.Hosts[1].SandboxID != "sb_b" {
		t.Fatalf("hosts not sorted by id: %+v", state.Hosts)
	}
	if state.Hosts[1].HostName != "new" {
		t.Fatalf("expected replaced host, got %q", state.Hosts[1].HostName)
	}
}

func TestEnsureIncludeCreatesAndIsIdempotent(t *testing.T) {
	paths := testPaths(t)
	configPath, _ := paths.SSHConfigFile()
	includeLine := "Include " + basedir.SSHAmikaConfigName()

	if err := EnsureInclude(paths); err != nil {
		t.Fatalf("EnsureInclude (create): %v", err)
	}
	if err := EnsureInclude(paths); err != nil {
		t.Fatalf("EnsureInclude (idempotent): %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if n := strings.Count(string(data), includeLine); n != 1 {
		t.Fatalf("expected exactly 1 include line, got %d:\n%s", n, data)
	}
	assertPerm(t, configPath, 0o600)
}

func TestEnsureIncludePreservesExistingConfig(t *testing.T) {
	paths := testPaths(t)
	configPath, _ := paths.SSHConfigFile()
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	existing := "Host example\n  HostName example.com\n"
	if err := os.WriteFile(configPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInclude(paths); err != nil {
		t.Fatalf("EnsureInclude: %v", err)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.Contains(content, existing) {
		t.Errorf("existing config not preserved:\n%s", content)
	}
	includeIdx := strings.Index(content, "Include "+basedir.SSHAmikaConfigName())
	hostIdx := strings.Index(content, "Host example")
	if includeIdx < 0 || includeIdx > hostIdx {
		t.Errorf("include should precede existing Host blocks:\n%s", content)
	}
}

func TestEnsureIncludePreservesSymlinkedConfig(t *testing.T) {
	paths := testPaths(t)
	configPath, _ := paths.SSHConfigFile()
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}

	targetDir := filepath.Join(t.TempDir(), "dotfiles")
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(targetDir, "ssh_config")
	existing := "Host example\n  HostName example.com\n"
	if err := os.WriteFile(targetPath, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	relativeTarget, err := filepath.Rel(filepath.Dir(configPath), targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(relativeTarget, configPath); err != nil {
		t.Fatal(err)
	}

	if err := EnsureInclude(paths); err != nil {
		t.Fatalf("EnsureInclude: %v", err)
	}

	info, err := os.Lstat(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%q is no longer a symlink", configPath)
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if !strings.Contains(content, "Include "+basedir.SSHAmikaConfigName()) {
		t.Errorf("target config missing include:\n%s", content)
	}
	if !strings.Contains(content, existing) {
		t.Errorf("target config did not preserve existing content:\n%s", content)
	}
	assertPerm(t, targetPath, 0o600)
}

func TestUpsertHostWritesAllArtifacts(t *testing.T) {
	paths := testPaths(t)

	alias, err := UpsertHost(paths, HostEntry{
		SandboxID:   "sb_1",
		SandboxName: "my-sandbox",
		HostName:    "ssh.app.daytona.io",
		User:        "token",
	})
	if err != nil {
		t.Fatalf("UpsertHost: %v", err)
	}
	if alias != "amika-sb_1" {
		t.Fatalf("alias = %q", alias)
	}

	confPath, _ := paths.SSHAmikaConfigFile()
	conf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	if !strings.Contains(string(conf), "Host amika-sb_1") || !strings.Contains(string(conf), "# my-sandbox") {
		t.Errorf("amika.conf missing alias or name comment:\n%s", conf)
	}
	assertPerm(t, confPath, 0o600)

	configPath, _ := paths.SSHConfigFile()
	cfg, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read ssh config: %v", err)
	}
	if !strings.Contains(string(cfg), "Include "+basedir.SSHAmikaConfigName()) {
		t.Errorf("ssh config missing include:\n%s", cfg)
	}

	// Refreshing the same sandbox replaces its entry rather than duplicating it.
	if _, err := UpsertHost(paths, HostEntry{
		SandboxID:   "sb_1",
		SandboxName: "my-sandbox",
		HostName:    "ssh.app.daytona.io",
		User:        "token-2",
	}); err != nil {
		t.Fatalf("UpsertHost refresh: %v", err)
	}
	state, err := LoadState(paths)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Hosts) != 1 || state.Hosts[0].User != "token-2" {
		t.Fatalf("expected single refreshed host, got %+v", state.Hosts)
	}
}

// testPaths returns a basedir.Paths rooted in temp dirs so tests touch neither
// the real ~/.ssh nor the real XDG state directory.
func testPaths(t *testing.T) basedir.Paths {
	t.Helper()
	home := t.TempDir()
	// basedir.New(home) only controls the fallback home-derived paths. Pin
	// XDG_STATE_HOME too so package tests never touch the developer's real state.
	t.Setenv("XDG_STATE_HOME", filepath.Join(t.TempDir(), "state"))
	return basedir.New(home)
}

func assertPerm(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %q: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("perm of %q = %o, want %o", path, got, want)
	}
}

// testBinary creates a stand-in amika executable and points AMIKA_BINARY_PATH
// at it, mirroring how a wrapper script names itself.
func testBinary(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/bash\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EnvBinaryPath, path)
	return path
}

func TestConfigureSessionWritesTheCurrentEnvironmentsBlock(t *testing.T) {
	paths := testPaths(t)
	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	binary := testBinary(t, "amika-local")

	if err := ConfigureSession(paths, SessionConfig{
		IdentityFile:   "/home/user/.ssh/amika_id_ed25519",
		KnownHostsFile: "/home/user/.ssh/amika_known_hosts",
	}); err != nil {
		t.Fatalf("ConfigureSession: %v", err)
	}

	confPath, _ := paths.SSHAmikaConfigFile()
	conf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	for _, want := range []string{
		"Host *.localhost-3011.amika",
		"ProxyCommand " + binary + " plumbing ssh-stdio-proxy %h",
	} {
		if !strings.Contains(string(conf), want) {
			t.Errorf("amika.conf missing %q:\n%s", want, conf)
		}
	}
}

// Each control plane owns its own sandboxes, so connecting to a second one adds
// a block rather than replacing the first: aliases for both must keep working.
func TestConfigureSessionKeepsOneBlockPerEnvironment(t *testing.T) {
	paths := testPaths(t)
	session := SessionConfig{
		IdentityFile:   "/home/user/.ssh/amika_id_ed25519",
		KnownHostsFile: "/home/user/.ssh/amika_known_hosts",
	}

	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	localBinary := testBinary(t, "amika-local")
	if err := ConfigureSession(paths, session); err != nil {
		t.Fatalf("ConfigureSession local: %v", err)
	}

	t.Setenv(config.EnvAPIURL, "https://app.staging-amika.dev")
	stagingBinary := testBinary(t, "amika-staging")
	if err := ConfigureSession(paths, session); err != nil {
		t.Fatalf("ConfigureSession staging: %v", err)
	}

	confPath, _ := paths.SSHAmikaConfigFile()
	conf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	for _, want := range []string{
		"Host *.localhost-3011.amika",
		"ProxyCommand " + localBinary + " plumbing ssh-stdio-proxy %h",
		"Host *.app-staging-amika-dev.amika",
		"ProxyCommand " + stagingBinary + " plumbing ssh-stdio-proxy %h",
	} {
		if !strings.Contains(string(conf), want) {
			t.Errorf("amika.conf missing %q:\n%s", want, conf)
		}
	}
	// Sorted rendering keeps the file from churning between runs.
	if strings.Index(string(conf), "*.app-staging-amika-dev.amika") > strings.Index(string(conf), "*.localhost-3011.amika") {
		t.Errorf("environment blocks are not in sorted order:\n%s", conf)
	}
}

// Re-running against the same environment with a different binary replaces that
// environment's ProxyCommand instead of accumulating a stale one.
func TestConfigureSessionReplacesAnEnvironmentsStaleProxyCommand(t *testing.T) {
	paths := testPaths(t)
	session := SessionConfig{
		IdentityFile:   "/home/user/.ssh/amika_id_ed25519",
		KnownHostsFile: "/home/user/.ssh/amika_known_hosts",
	}
	t.Setenv(config.EnvAPIURL, "http://localhost:3011")

	oldBinary := testBinary(t, "amika-old")
	if err := ConfigureSession(paths, session); err != nil {
		t.Fatalf("ConfigureSession first: %v", err)
	}
	newBinary := testBinary(t, "amika-new")
	if err := ConfigureSession(paths, session); err != nil {
		t.Fatalf("ConfigureSession second: %v", err)
	}

	confPath, _ := paths.SSHAmikaConfigFile()
	conf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	if strings.Contains(string(conf), oldBinary) {
		t.Errorf("amika.conf kept the stale ProxyCommand:\n%s", conf)
	}
	if !strings.Contains(string(conf), newBinary) {
		t.Errorf("amika.conf missing the new ProxyCommand:\n%s", conf)
	}
	if got := strings.Count(string(conf), "Host *.localhost-3011.amika"); got != 1 {
		t.Errorf("expected exactly one block for the environment, got %d:\n%s", got, conf)
	}
}

// State written before session blocks became per-environment carries a
// ProxyCommand inside session_config and no session_proxy_commands. Its
// environment-agnostic `Host *.amika` block would still match every new alias
// and win the ProxyCommand for it, so regeneration must drop it.
func TestLegacySessionStateLosesItsEnvironmentAgnosticWildcard(t *testing.T) {
	paths := testPaths(t)
	statePath, err := paths.SSHHostsStateFile()
	if err != nil {
		t.Fatal(err)
	}
	legacy := `{
  "hosts": [],
  "session_config": {
    "IdentityFile": "/home/user/.ssh/amika_id_ed25519",
    "KnownHostsFile": "/home/user/.ssh/amika_known_hosts",
    "ProxyCommand": "amika plumbing ssh-stdio-proxy %h"
  }
}`
	if err := writeFileAtomic(statePath, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}

	state, err := LoadState(paths)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	// The imported identity survives; only the environment-less block is lost.
	if state.SessionConfig == nil || state.SessionConfig.IdentityFile != "/home/user/.ssh/amika_id_ed25519" {
		t.Fatalf("session identity not preserved: %#v", state.SessionConfig)
	}
	if rendered := Render(state); strings.Contains(rendered, "Host *.amika") {
		t.Errorf("legacy wildcard survived regeneration:\n%s", rendered)
	}

	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	binary := testBinary(t, "amika-local")
	if err := ConfigureSession(paths, *state.SessionConfig); err != nil {
		t.Fatalf("ConfigureSession: %v", err)
	}
	confPath, _ := paths.SSHAmikaConfigFile()
	conf, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	if strings.Contains(string(conf), "Host *.amika\n") {
		t.Errorf("amika.conf still has the environment-agnostic wildcard:\n%s", conf)
	}
	if !strings.Contains(string(conf), "ProxyCommand "+binary+" plumbing ssh-stdio-proxy %h") {
		t.Errorf("amika.conf missing the resolved ProxyCommand:\n%s", conf)
	}
}
