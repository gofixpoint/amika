package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
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

// stubV2SSHClient implements the APIs `sandbox open` uses before it hands the prepared
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

func TestOpenSandboxInClaude(t *testing.T) {
	opened := stubOpenApp(t)
	paths, home := testSSHPaths(t)
	target := sandboxSSHAlias{alias: "my-sandbox.sb_abc.app-amika-dev.amika", sandboxName: "my-sandbox", repoName: "biz"}

	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	if err := openSandboxInClaudeTarget(cmd, paths, target, ""); err != nil {
		t.Fatalf("openSandboxInClaude: %v", err)
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
	if got.ID != "my-sandbox.sb_abc.app-amika-dev.amika" || got.SSHHost != "my-sandbox.sb_abc.app-amika-dev.amika" || got.Name != "Amika: my-sandbox" {
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
	target := sandboxSSHAlias{alias: "my-sandbox.sb_abc.app-amika-dev.amika", sandboxName: "my-sandbox", repoName: "biz"}

	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})
	if err := openSandboxInCodexTarget(cmd, paths, target, ""); err != nil {
		t.Fatalf("openSandboxInCodex: %v", err)
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

func TestOpenSandboxInPaseo(t *testing.T) {
	cmd := &cobra.Command{}
	out := &bytes.Buffer{}
	cmd.SetOut(out)
	target := sandboxSSHAlias{
		alias:       "dylan.paseo-setup.sb_abc.app-amika-dev.amika",
		sandboxName: "paseo-setup",
	}

	if err := openSandboxInEditor(cmd, "paseo", nil, target, ""); err != nil {
		t.Fatalf("openSandboxInEditor: %v", err)
	}

	want := "Make sure you have Paseo set up in your rig VM. See docs:\n\n" +
		"https://docs.amika.dev/guides/paseo\n\n" +
		"Open Paseo and click on \"Hosts > Add host > Remote SSH\" in the bottom left.\n\n" +
		"Copy paste this SSH host:\n\n" +
		"ssh://amika@dylan.paseo-setup.sb_abc.app-amika-dev.amika\n"
	if got := out.String(); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

// fakeHerdrScript stands in for the herdr CLI: `machine list --json` prints
// machines.json from its own directory (failing when there is none), and any
// other invocation records its argv, one per line, to add-args.
const fakeHerdrScript = `#!/bin/sh
dir=$(dirname "$0")
if [ "$1 $2" = "machine list" ]; then exec cat "$dir/machines.json"; fi
printf '%s\n' "$@" > "$dir/add-args"
`

// installFakeHerdr puts fakeHerdrScript alone on PATH. machinesJSON, when not
// empty, is what `herdr machine list --json` reports. It returns the directory
// holding the script and its records.
func installFakeHerdr(t *testing.T, machinesJSON string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "herdr"), []byte(fakeHerdrScript), 0o755); err != nil {
		t.Fatalf("write fake herdr: %v", err)
	}
	if machinesJSON != "" {
		if err := os.WriteFile(filepath.Join(dir, "machines.json"), []byte(machinesJSON), 0o644); err != nil {
			t.Fatalf("write machines.json: %v", err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+"/bin:/usr/bin")
	return dir
}

// herdrAddArgs returns the argv the fake herdr recorded for `machine add`, or
// nil when it was never run.
func herdrAddArgs(t *testing.T, dir string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "add-args"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatalf("read add-args: %v", err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

var herdrTestTarget = sandboxSSHAlias{
	alias:       "dylan.herdr-setup.sb_abc.app-amika-dev.amika",
	sandboxName: "herdr-setup",
}

// TestOpenSandboxInHerdrAddsMachine registers the prepared SSH alias as a Herdr
// machine labeled with the sandbox name, both when Herdr reports its saved
// machines and when listing them fails.
func TestOpenSandboxInHerdrAddsMachine(t *testing.T) {
	for _, tt := range []struct {
		name     string
		machines string
	}{
		{name: "no saved machines", machines: "[]"},
		{name: "other machines", machines: `[{"id":"m1","label":"other","target":"other.sb_x.app-amika-dev.amika"}]`},
		{name: "list fails", machines: ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			dir := installFakeHerdr(t, tt.machines)
			cmd := &cobra.Command{}
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})

			if err := openSandboxInEditor(cmd, "herdr", nil, herdrTestTarget, ""); err != nil {
				t.Fatalf("openSandboxInEditor: %v", err)
			}

			want := []string{"machine", "add", herdrTestTarget.alias, "--label", herdrTestTarget.sandboxName}
			if got := herdrAddArgs(t, dir); !reflect.DeepEqual(got, want) {
				t.Fatalf("herdr args = %q, want %q", got, want)
			}
		})
	}
}

// TestOpenSandboxInHerdrSkipsSavedMachine reports a sandbox Herdr already has
// instead of adding it again, which Herdr would refuse over the duplicate label.
func TestOpenSandboxInHerdrSkipsSavedMachine(t *testing.T) {
	dir := installFakeHerdr(t, `[{"id":"m1","label":"herdr-setup","target":"`+herdrTestTarget.alias+`"}]`)
	cmd := &cobra.Command{}
	out := &bytes.Buffer{}
	cmd.SetOut(out)

	if err := openSandboxInEditor(cmd, "herdr", nil, herdrTestTarget, ""); err != nil {
		t.Fatalf("openSandboxInEditor: %v", err)
	}

	if got := herdrAddArgs(t, dir); got != nil {
		t.Fatalf("herdr machine add ran with %q, want it skipped", got)
	}
	if !strings.Contains(out.String(), `already a Herdr machine labeled "herdr-setup"`) {
		t.Fatalf("output = %q", out.String())
	}
}

// TestOpenSandboxInHerdrRejectsTakenLabel names the conflicting machine when
// the sandbox's label belongs to a different SSH host, e.g. a recreated rig.
func TestOpenSandboxInHerdrRejectsTakenLabel(t *testing.T) {
	dir := installFakeHerdr(t, `[{"id":"m1","label":"herdr-setup","target":"dylan.herdr-setup.sb_old.app-amika-dev.amika"}]`)
	cmd := &cobra.Command{}
	cmd.SetOut(&bytes.Buffer{})

	err := openSandboxInEditor(cmd, "herdr", nil, herdrTestTarget, "")
	if err == nil || !strings.Contains(err.Error(), `herdr machine remove m1`) {
		t.Fatalf("err = %v, want a hint to remove machine m1", err)
	}
	if got := herdrAddArgs(t, dir); got != nil {
		t.Fatalf("herdr machine add ran with %q, want it skipped", got)
	}
}

// TestOpenSandboxInHerdrRequiresCLI fails before printing anything when herdr
// is not on PATH.
func TestOpenSandboxInHerdrRequiresCLI(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	cmd := &cobra.Command{}
	out := &bytes.Buffer{}
	cmd.SetOut(out)

	err := openSandboxInEditor(cmd, "herdr", nil, herdrTestTarget, "")
	if err == nil || !strings.Contains(err.Error(), "install it from https://herdr.dev") {
		t.Fatalf("err = %v, want an install hint", err)
	}
	if out.Len() != 0 {
		t.Fatalf("output = %q, want none", out.String())
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
	target := sandboxSSHAlias{alias: "my-sandbox.sb_abc.app-amika-dev.amika", sandboxName: "my-sandbox", repoName: "biz"}
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

// TestSSHCommandNames preserves the v2 aliases for the current transports.
func TestSSHCommandNames(t *testing.T) {
	for _, tt := range []struct {
		cmd         *cobra.Command
		wantName    string
		wantHidden  bool
		wantAliases []string
	}{
		{cmd: sandboxSSHV2Cmd, wantName: "ssh", wantHidden: false, wantAliases: []string{"sshv2"}},
		{cmd: sandboxCodeV2Cmd, wantName: "open", wantHidden: false, wantAliases: []string{"code", "codev2"}},
	} {
		t.Run(tt.wantName, func(t *testing.T) {
			if got := tt.cmd.Name(); got != tt.wantName {
				t.Errorf("command name = %q, want %q", got, tt.wantName)
			}
			if tt.cmd.Hidden != tt.wantHidden {
				t.Errorf("Hidden = %v, want %v", tt.cmd.Hidden, tt.wantHidden)
			}
			if !reflect.DeepEqual(tt.cmd.Aliases, tt.wantAliases) {
				t.Errorf("Aliases = %#v, want %#v", tt.cmd.Aliases, tt.wantAliases)
			}
		})
	}
}

// TestAppFlagAcceptsEditorAlias reads the app from --app or --editor, and
// rejects the two only when they name different editors.
func TestAppFlagAcceptsEditorAlias(t *testing.T) {
	for _, tt := range []struct {
		name    string
		args    []string
		want    string
		wantErr bool
	}{
		{name: "default", args: nil, want: "cursor"},
		{name: "app", args: []string{"--app=claude"}, want: "claude"},
		{name: "editor", args: []string{"--editor=vscode"}, want: "vscode"},
		{name: "both agree", args: []string{"--app=codex", "--editor=codex"}, want: "codex"},
		{name: "both disagree", args: []string{"--app=claude", "--editor=codex"}, wantErr: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cmd := &cobra.Command{}
			cmd.Flags().String("app", "cursor", "")
			cmd.Flags().String("editor", "", "")
			if err := cmd.Flags().Parse(tt.args); err != nil {
				t.Fatalf("parse %v: %v", tt.args, err)
			}
			got, err := appFlag(cmd)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("appFlag() = %q, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("appFlag: %v", err)
			}
			if got != tt.want {
				t.Errorf("appFlag() = %q, want %q", got, tt.want)
			}
		})
	}
}
