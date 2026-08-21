package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/gofixpoint/amika/go/internal/wslbridge"
	"github.com/spf13/cobra"
)

// stubOpenApp replaces openApp with a recorder for the duration of a test so
// no real desktop app is launched.
func stubOpenApp(t *testing.T) *[]string {
	t.Helper()
	var opened []string
	prev := openApp
	openApp = func(url string) error {
		opened = append(opened, url)
		return nil
	}
	t.Cleanup(func() { openApp = prev })
	return &opened
}

func TestResolveRemoteWorkspacePath(t *testing.T) {
	tests := []struct {
		name         string
		repoName     string
		pathOverride string
		want         string
	}{
		{
			name: "no override no repo",
			want: "/home/amika/workspace",
		},
		{
			name:     "no override with repo",
			repoName: "biz",
			want:     "/home/amika/workspace/biz",
		},
		{
			name:         "relative override resolves against home",
			repoName:     "biz",
			pathOverride: "workspace/biz",
			want:         "/home/amika/workspace/biz",
		},
		{
			name:         "relative override subdirectory",
			repoName:     "biz",
			pathOverride: "workspace/biz/src",
			want:         "/home/amika/workspace/biz/src",
		},
		{
			name:         "relative override ignores repo name",
			repoName:     "biz",
			pathOverride: "workspace/other",
			want:         "/home/amika/workspace/other",
		},
		{
			name:         "absolute override used verbatim",
			repoName:     "biz",
			pathOverride: "/custom/path",
			want:         "/custom/path",
		},
		{
			name:         "absolute override no repo",
			pathOverride: "/home/amika/workspace/biz",
			want:         "/home/amika/workspace/biz",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveRemoteWorkspacePath(tt.repoName, tt.pathOverride)
			if got != tt.want {
				t.Errorf("resolveRemoteWorkspacePath(%q, %q) = %q, want %q",
					tt.repoName, tt.pathOverride, got, tt.want)
			}
		})
	}
}

// stubSSHClient implements sshInfoClient for testing.
type stubSSHClient struct {
	info    *apiclient.SSHInfo
	sandbox *apiclient.RemoteSandbox
}

// stubV2SSHClient implements the APIs `sandbox code` uses before it hands the prepared
// alias to an editor. Its session method is not reached by this test because
// prepareSessionTarget is replaced with a recorder.
type stubV2SSHClient struct {
	sandbox *apiclient.RemoteSandbox
}

func (s *stubV2SSHClient) GetSandbox(_ string) (*apiclient.RemoteSandbox, error) {
	return s.sandbox, nil
}

func (s *stubV2SSHClient) CreateSSHSession(_ string) (*apiclient.SSHSession, error) {
	return nil, nil
}

func (s *stubSSHClient) GetSSH(_ string) (*apiclient.SSHInfo, error) {
	return s.info, nil
}

func (s *stubSSHClient) GetSandbox(_ string) (*apiclient.RemoteSandbox, error) {
	return s.sandbox, nil
}

func testSSHPaths(t *testing.T) (basedir.Paths, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", filepath.Join(t.TempDir(), "state"))
	return basedir.New(home), home
}

func TestValidateEditor(t *testing.T) {
	for _, editor := range supportedEditors {
		t.Run(editor+" is allowed", func(t *testing.T) {
			if err := validateEditor(editor); err != nil {
				t.Fatalf("%q should be allowed: %v", editor, err)
			}
		})
	}

	if err := validateEditor("vim"); err == nil {
		t.Fatal("expected unknown editor to be rejected")
	}
}

func daytonaInfo() *apiclient.SSHInfo {
	return &apiclient.SSHInfo{
		SSHDestination: "-p 2222 tok@ssh.app.daytona.io",
		SandboxID:      "sb_abc",
		SandboxName:    "my-sandbox",
		RepoName:       "biz",
	}
}

func TestOpenSandboxInClaude(t *testing.T) {
	opened := stubOpenApp(t)
	paths, home := testSSHPaths(t)
	client := &stubSSHClient{info: daytonaInfo()}

	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	if err := openSandboxInClaude(cmd, client, paths, "my-sandbox", ""); err != nil {
		t.Fatalf("openSandboxInClaude: %v", err)
	}

	// The stable alias landed in the managed SSH config.
	amikaConf, err := os.ReadFile(filepath.Join(home, ".ssh", "amika.conf"))
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	if !bytes.Contains(amikaConf, []byte("Host amika-sb_abc")) {
		t.Fatalf("amika.conf missing alias:\n%s", amikaConf)
	}

	// The Claude environment was registered against that alias.
	var doc struct {
		SSHConfigs []struct {
			ID             string `json:"id"`
			Name           string `json:"name"`
			SSHHost        string `json:"sshHost"`
			StartDirectory string `json:"startDirectory"`
		} `json:"sshConfigs"`
	}
	data, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		t.Fatalf("read claude settings: %v", err)
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse claude settings: %v", err)
	}
	if len(doc.SSHConfigs) != 1 {
		t.Fatalf("expected 1 sshConfigs entry, got %d", len(doc.SSHConfigs))
	}
	got := doc.SSHConfigs[0]
	if got.ID != "amika-sb_abc" || got.SSHHost != "amika-sb_abc" || got.Name != "Amika: my-sandbox" {
		t.Fatalf("unexpected entry: %+v", got)
	}
	if got.StartDirectory != "/home/amika/workspace/biz" {
		t.Fatalf("startDirectory = %q, want /home/amika/workspace/biz", got.StartDirectory)
	}
	if len(*opened) != 1 || (*opened)[0] != "claude://code/new" {
		t.Fatalf("expected claude deep link to be opened, got %v", *opened)
	}
}

func TestOpenSandboxInCodex(t *testing.T) {
	opened := stubOpenApp(t)
	paths, home := testSSHPaths(t)
	client := &stubSSHClient{info: daytonaInfo()}

	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	if err := openSandboxInCodex(cmd, client, paths, "my-sandbox", ""); err != nil {
		t.Fatalf("openSandboxInCodex: %v", err)
	}

	amikaConf, err := os.ReadFile(filepath.Join(home, ".ssh", "amika.conf"))
	if err != nil {
		t.Fatalf("read amika.conf: %v", err)
	}
	if !bytes.Contains(amikaConf, []byte("Host amika-sb_abc")) {
		t.Fatalf("amika.conf missing alias:\n%s", amikaConf)
	}

	var cfg struct {
		Features struct {
			RemoteConnections bool `toml:"remote_connections"`
		} `toml:"features"`
	}
	data, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		t.Fatalf("read codex config: %v", err)
	}
	if err := toml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("parse codex config: %v", err)
	}
	if !cfg.Features.RemoteConnections {
		t.Fatalf("expected features.remote_connections=true, got %s", data)
	}
	if len(*opened) != 1 || (*opened)[0] != "codex://" {
		t.Fatalf("expected codex deep link to be opened, got %v", *opened)
	}
}

func TestResolveSandboxV2SSHAliasUsesSharedSessionPreparation(t *testing.T) {
	paths, _ := testSSHPaths(t)
	repoName := "biz"
	client := &stubV2SSHClient{sandbox: &apiclient.RemoteSandbox{
		ID:       "sb_abc",
		Name:     "my-sandbox",
		RepoName: &repoName,
	}}

	previous := prepareSessionTarget
	previousUpsert := upsertSessionHost
	var gotName, gotID string
	var gotAlias string
	prepareSessionTarget = func(gotPaths basedir.Paths, _ ssh.SessionCreator, name, id string) (string, error) {
		if gotPaths != paths {
			t.Fatalf("paths = %#v, want %#v", gotPaths, paths)
		}
		gotName, gotID = name, id
		return "my-sandbox.sb_abc.app-amika-dev.amika", nil
	}
	upsertSessionHost = func(gotPaths basedir.Paths, alias string) error {
		if gotPaths != paths {
			t.Fatalf("paths = %#v, want %#v", gotPaths, paths)
		}
		gotAlias = alias
		return nil
	}
	t.Cleanup(func() {
		prepareSessionTarget = previous
		upsertSessionHost = previousUpsert
	})

	target, err := resolveSandboxV2SSHAlias(client, paths, "lookup-name")
	if err != nil {
		t.Fatalf("resolveSandboxV2SSHAlias: %v", err)
	}
	if gotName != "my-sandbox" || gotID != "sb_abc" {
		t.Fatalf("PrepareSessionTarget(%q, %q), want sandbox identity", gotName, gotID)
	}
	if gotAlias != "my-sandbox.sb_abc.app-amika-dev.amika" {
		t.Fatalf("UpsertSessionHost(%q), want prepared alias", gotAlias)
	}
	if target.alias != "my-sandbox.sb_abc.app-amika-dev.amika" || target.sandboxName != "my-sandbox" || target.repoName != "biz" {
		t.Fatalf("target = %#v", target)
	}
}

// stubWSLSeams wires the WSL handoff seams to recorders, so the editor
// launch runs to completion in tests without a Windows side.
func stubWSLSeams(t *testing.T) (*[]wslbridge.Target, *[][]string) {
	t.Helper()
	var mirrored []wslbridge.Target
	var launched [][]string

	prevIsWSL, prevTarget, prevExe, prevLaunch, prevMirror := wslIsWSL, wslResolveTarget, wslEditorExe, wslLaunchWindows, mirrorSSHToWindows
	wslIsWSL = func() bool { return true }
	wslResolveTarget = func() (wslbridge.Target, error) {
		return wslbridge.Target{
			SSHDir:        t.TempDir(),
			SSHDirWindows: `C:\Users\testuser\.ssh`,
			Distro:        "Ubuntu",
			User:          "testuser",
		}, nil
	}
	wslEditorExe = func(string) (string, error) {
		return `C:\Users\testuser\AppData\Local\Programs\Microsoft VS Code\Code.exe`, nil
	}
	wslLaunchWindows = func(exe string, args ...string) error {
		launched = append(launched, append([]string{exe}, args...))
		return nil
	}
	mirrorSSHToWindows = func(_ basedir.Paths, target wslbridge.Target) error {
		mirrored = append(mirrored, target)
		return nil
	}
	t.Cleanup(func() {
		wslIsWSL, wslResolveTarget, wslEditorExe, wslLaunchWindows, mirrorSSHToWindows = prevIsWSL, prevTarget, prevExe, prevLaunch, prevMirror
	})
	return &mirrored, &launched
}

func TestOpenSandboxInEditorMirrorsToWindowsUnderWSL(t *testing.T) {
	mirrored, launched := stubWSLSeams(t)
	paths, _ := testSSHPaths(t)

	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	target := sandboxSSHAlias{alias: "my-sandbox.sb_abc.prod.amika", sandboxName: "my-sandbox", repoName: "biz"}
	if err := openSandboxInEditor(cmd, "vscode", paths, target, ""); err != nil {
		t.Fatalf("openSandboxInEditor: %v", err)
	}
	if len(*mirrored) != 1 {
		t.Fatalf("mirror calls = %d, want 1", len(*mirrored))
	}
	if (*mirrored)[0].User != "testuser" {
		t.Fatalf("mirrored target = %+v", (*mirrored)[0])
	}
	if len(*launched) != 1 {
		t.Fatalf("launch calls = %d, want 1", len(*launched))
	}
	argv := (*launched)[0]
	if !strings.HasSuffix(argv[0], "Code.exe") ||
		argv[1] != "--remote" ||
		argv[2] != "ssh-remote+my-sandbox.sb_abc.prod.amika" ||
		argv[3] != "/home/amika/workspace/biz" {
		t.Fatalf("launch argv = %q", argv)
	}

	// The same handoff serves Cursor, which shares the launcher.
	*mirrored, *launched = nil, nil
	if err := openSandboxInEditor(cmd, "cursor", paths, target, ""); err != nil {
		t.Fatalf("openSandboxInEditor(cursor): %v", err)
	}
	if len(*mirrored) != 1 || len(*launched) != 1 {
		t.Fatalf("mirror/launch calls = %d/%d, want 1/1", len(*mirrored), len(*launched))
	}
}

func TestOpenSandboxInEditorSkipsWindowsWhenNotWSL(t *testing.T) {
	mirrored, launched := stubWSLSeams(t)
	wslIsWSL = func() bool { return false }
	// An empty PATH makes the local editor CLI lookup fail deterministically,
	// so the test observes the requirement without launching a real editor.
	t.Setenv("PATH", t.TempDir())
	paths, _ := testSSHPaths(t)

	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	target := sandboxSSHAlias{alias: "amika-sb_abc", sandboxName: "my-sandbox", repoName: "biz"}
	// Without WSL the launcher requires the editor CLI locally; the error
	// names the install hint rather than touching the Windows side.
	err := openSandboxInEditor(cmd, "vscode", paths, target, "")
	if err == nil {
		t.Fatal("expected a local editor CLI requirement")
	}
	if !strings.Contains(err.Error(), `install it from the VS Code Command Palette`) {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(*mirrored) != 0 || len(*launched) != 0 {
		t.Fatalf("mirror/launch calls = %d/%d, want 0/0", len(*mirrored), len(*launched))
	}
}

// TestSSHCommandNames pins the CLI surface the rename established: the direct
// WebSocket transport owns the plain `ssh`/`code` names and is listed in help,
// while the provider-native predecessors stay reachable under `sshv1`/`codev1`
// but hidden. New() is a once-per-process call, so assert on the command
// objects rather than building the tree.
func TestSSHCommandNames(t *testing.T) {
	for _, tt := range []struct {
		cmd        *cobra.Command
		wantName   string
		wantHidden bool
	}{
		{cmd: sandboxSSHV2Cmd, wantName: "ssh", wantHidden: false},
		{cmd: sandboxCodeV2Cmd, wantName: "code", wantHidden: false},
		{cmd: sandboxSSHV1Cmd, wantName: "sshv1", wantHidden: true},
		{cmd: sandboxCodeV1Cmd, wantName: "codev1", wantHidden: true},
	} {
		t.Run(tt.wantName, func(t *testing.T) {
			if got := tt.cmd.Name(); got != tt.wantName {
				t.Errorf("command name = %q, want %q", got, tt.wantName)
			}
			if tt.cmd.Hidden != tt.wantHidden {
				t.Errorf("Hidden = %v, want %v", tt.cmd.Hidden, tt.wantHidden)
			}
		})
	}
}
