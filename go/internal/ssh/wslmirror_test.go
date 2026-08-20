package ssh

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/wslbridge"
)

func TestBuildWSLProxyCommand(t *testing.T) {
	got, err := BuildWSLProxyCommand("Ubuntu-22.04", "/usr/local/bin/amika")
	if err != nil {
		t.Fatalf("BuildWSLProxyCommand: %v", err)
	}
	want := "wsl.exe -d Ubuntu-22.04 -e /usr/local/bin/amika plumbing ssh-stdio-proxy %h"
	if got != want {
		t.Fatalf("BuildWSLProxyCommand = %q, want %q", got, want)
	}

	tests := []struct {
		name   string
		distro string
		binary string
	}{
		{name: "distro with space", distro: "My Distro", binary: "/usr/local/bin/amika"},
		{name: "distro with metachar", distro: "Ubuntu;rm -rf", binary: "/usr/local/bin/amika"},
		{name: "binary with space", distro: "Ubuntu", binary: "/opt/amika bin/amika"},
		{name: "binary with semicolon", distro: "Ubuntu", binary: "/opt/amika;sh"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := BuildWSLProxyCommand(tt.distro, tt.binary); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

// windowsTestTarget points the mirror at a scratch directory while keeping
// Windows-style path spelling for the rendered config.
func windowsTestTarget(dir string) wslbridge.Target {
	return wslbridge.Target{
		SSHDir:        dir,
		SSHDirWindows: `C:\Users\testuser\.ssh`,
		Distro:        "Ubuntu",
		User:          "testuser",
	}
}

// sessionTestState builds a fully valid state: one provider-native host plus
// a session configured against the caller's paths.
func sessionTestState(t *testing.T, paths basedir.Paths) HostsState {
	t.Helper()
	identity, err := paths.SSHIdentityFile()
	if err != nil {
		t.Fatal(err)
	}
	knownHosts, err := paths.SSHKnownHostsFile()
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := BuildProxyCommand("/usr/local/bin/amika")
	if err != nil {
		t.Fatal(err)
	}
	return HostsState{
		Hosts: []HostEntry{{
			SandboxID:   "sb_1",
			SandboxName: "my-sandbox",
			HostName:    "ssh.app.daytona.io",
			User:        "tok",
			Port:        2222,
		}},
		SessionConfig: &SessionConfig{
			IdentityFile:   identity,
			KnownHostsFile: knownHosts,
		},
		SessionProxyCommands: map[string]string{"prod": proxy},
		SessionHosts:         []SessionHostEntry{{Alias: "my-sandbox.sb_1.prod.amika"}},
	}
}

func TestRenderWindows(t *testing.T) {
	state := sessionTestState(t, testPaths(t))
	content, err := RenderWindows(state, windowsTestTarget(t.TempDir()))
	if err != nil {
		t.Fatalf("RenderWindows: %v", err)
	}

	for _, want := range []string{
		"Host amika-sb_1\n",
		"  HostName ssh.app.daytona.io\n",
		"Host my-sandbox.sb_1.prod.amika\n",
		`IdentityFile "C:\Users\testuser\.ssh\amika_id_ed25519"` + "\n",
		`UserKnownHostsFile "C:\Users\testuser\.ssh\amika_known_hosts"` + "\n",
		"ProxyCommand wsl.exe -d Ubuntu -e /usr/local/bin/amika plumbing ssh-stdio-proxy %h\n",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("rendered config missing %q:\n%s", want, content)
		}
	}
}

func TestRenderWindowsWithoutSession(t *testing.T) {
	state := sessionTestState(t, testPaths(t))
	state.SessionConfig = nil
	state.SessionProxyCommands = nil
	state.SessionHosts = nil

	content, err := RenderWindows(state, windowsTestTarget(t.TempDir()))
	if err != nil {
		t.Fatalf("RenderWindows: %v", err)
	}
	if strings.Contains(content, "ProxyCommand") {
		t.Fatalf("expected no session block without session state:\n%s", content)
	}
	if !strings.Contains(content, "Host amika-sb_1\n") {
		t.Fatalf("provider-native host should pass through:\n%s", content)
	}
}

func TestRenderWindowsRejectsUnsafeTarget(t *testing.T) {
	target := windowsTestTarget(t.TempDir())
	target.SSHDirWindows = `C:\Users\bad%name\.ssh`
	if _, err := RenderWindows(sessionTestState(t, testPaths(t)), target); err == nil {
		t.Fatal("expected error for a directory with an unsafe character")
	}
}

func TestMirrorToWindows(t *testing.T) {
	paths := testPaths(t)
	if err := SaveState(paths, sessionTestState(t, paths)); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	identity, err := paths.SSHIdentityFile()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(identity), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(identity, []byte("private key"), 0o600); err != nil {
		t.Fatal(err)
	}
	knownHosts, err := paths.SSHKnownHostsFile()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(knownHosts, []byte("my-sandbox.sb_1.prod.amika ssh-ed25519 AAAA\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var icaclsCalls [][2]string
	prevIcacls := runIcacls
	runIcacls = func(path, user string) error {
		icaclsCalls = append(icaclsCalls, [2]string{path, user})
		return nil
	}
	t.Cleanup(func() { runIcacls = prevIcacls })

	winSSH := filepath.Join(t.TempDir(), "winssh")
	target := windowsTestTarget(winSSH)
	if err := MirrorToWindows(paths, target); err != nil {
		t.Fatalf("MirrorToWindows: %v", err)
	}

	conf, err := os.ReadFile(filepath.Join(winSSH, "amika.conf"))
	if err != nil {
		t.Fatalf("read mirrored amika.conf: %v", err)
	}
	if !strings.Contains(string(conf), "ProxyCommand wsl.exe -d Ubuntu -e /usr/local/bin/amika") {
		t.Fatalf("mirrored config missing wsl proxy:\n%s", conf)
	}
	assertPerm(t, filepath.Join(winSSH, "amika.conf"), 0o600)

	config, err := os.ReadFile(filepath.Join(winSSH, "config"))
	if err != nil {
		t.Fatalf("read mirrored ssh config: %v", err)
	}
	if !strings.Contains(string(config), "Include amika.conf") {
		t.Fatalf("mirrored config missing include:\n%s", config)
	}

	copiedIdentity, err := os.ReadFile(filepath.Join(winSSH, "amika_id_ed25519"))
	if err != nil {
		t.Fatalf("read mirrored identity: %v", err)
	}
	if string(copiedIdentity) != "private key" {
		t.Fatalf("mirrored identity = %q", copiedIdentity)
	}

	copiedPins, err := os.ReadFile(filepath.Join(winSSH, "amika_known_hosts"))
	if err != nil {
		t.Fatalf("read mirrored known hosts: %v", err)
	}
	if !strings.Contains(string(copiedPins), "my-sandbox.sb_1.prod.amika") {
		t.Fatalf("mirrored known hosts missing pin:\n%s", copiedPins)
	}

	if len(icaclsCalls) != 1 {
		t.Fatalf("icacls calls = %v, want one", icaclsCalls)
	}
	want := [2]string{`C:\Users\testuser\.ssh\amika_id_ed25519`, "testuser"}
	if icaclsCalls[0] != want {
		t.Fatalf("icacls = %v, want %v", icaclsCalls[0], want)
	}
}

// TestMirrorToWindowsCopiesImportedIdentity covers the imported-key setup:
// the session config points outside the default identity path, and the mirror
// must copy that file, since the rendered Windows config only ever references
// the canonical mirrored name.
func TestMirrorToWindowsCopiesImportedIdentity(t *testing.T) {
	paths := testPaths(t)
	state := sessionTestState(t, paths)
	imported := filepath.Join(t.TempDir(), "imported_ed25519")
	if err := os.WriteFile(imported, []byte("imported private key"), 0o600); err != nil {
		t.Fatal(err)
	}
	state.SessionConfig.IdentityFile = imported
	if err := SaveState(paths, state); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	knownHosts, err := paths.SSHKnownHostsFile()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(knownHosts), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(knownHosts, []byte("my-sandbox.sb_1.prod.amika ssh-ed25519 AAAA\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	prevIcacls := runIcacls
	runIcacls = func(string, string) error { return nil }
	t.Cleanup(func() { runIcacls = prevIcacls })

	winSSH := filepath.Join(t.TempDir(), "winssh")
	if err := MirrorToWindows(paths, windowsTestTarget(winSSH)); err != nil {
		t.Fatalf("MirrorToWindows: %v", err)
	}
	copied, err := os.ReadFile(filepath.Join(winSSH, "amika_id_ed25519"))
	if err != nil {
		t.Fatalf("read mirrored identity: %v", err)
	}
	if string(copied) != "imported private key" {
		t.Fatalf("mirrored identity = %q, want the imported key", copied)
	}
}

// TestRenderWindowsSkipsUnrenderableBlocks matches the Linux renderer's
// contract: a stored entry that cannot render must vanish from the mirror,
// not block it, so the v1 provider hosts stay reachable.
func TestRenderWindowsSkipsUnrenderableBlocks(t *testing.T) {
	paths := testPaths(t)
	state := sessionTestState(t, paths)
	state.SessionProxyCommands["stage"] = "/opt/amika bin/amika plumbing ssh-stdio-proxy %h"
	state.SessionProxyCommands["bad\nHost *"] = state.SessionProxyCommands["prod"]

	content, err := RenderWindows(state, windowsTestTarget(t.TempDir()))
	if err != nil {
		t.Fatalf("RenderWindows: %v", err)
	}
	if !strings.Contains(content, "Host *.prod.amika") {
		t.Fatalf("valid block missing:\n%s", content)
	}
	if !strings.Contains(content, "Host amika-sb_1") {
		t.Fatalf("provider host missing:\n%s", content)
	}
	if strings.Contains(content, "stage") || strings.Contains(content, "bad") {
		t.Fatalf("unrenderable blocks leaked:\n%s", content)
	}
}

func TestMirrorToWindowsWithoutIdentity(t *testing.T) {
	paths := testPaths(t)
	state := sessionTestState(t, paths)
	state.SessionConfig = nil
	state.SessionProxyCommands = nil
	state.SessionHosts = nil
	if err := SaveState(paths, state); err != nil {
		t.Fatalf("SaveState: %v", err)
	}

	icaclsCalled := false
	prevIcacls := runIcacls
	runIcacls = func(string, string) error {
		icaclsCalled = true
		return nil
	}
	t.Cleanup(func() { runIcacls = prevIcacls })

	winSSH := filepath.Join(t.TempDir(), "winssh")
	if err := MirrorToWindows(paths, windowsTestTarget(winSSH)); err != nil {
		t.Fatalf("MirrorToWindows: %v", err)
	}
	if icaclsCalled {
		t.Fatal("icacls must not run when no identity was mirrored")
	}
	if _, err := os.Stat(filepath.Join(winSSH, "amika.conf")); err != nil {
		t.Fatalf("mirrored config should exist: %v", err)
	}
}
