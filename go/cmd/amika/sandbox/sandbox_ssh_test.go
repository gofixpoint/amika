package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/ssh"
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

// stubV2SSHClient implements the APIs codev2 uses before it hands the prepared
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
	t.Run("cursor is always allowed", func(t *testing.T) {
		t.Setenv(claudeCodexSupportEnv, "")
		if err := validateEditor("cursor"); err != nil {
			t.Fatalf("cursor should be allowed: %v", err)
		}
	})

	t.Run("unknown editor is rejected", func(t *testing.T) {
		t.Setenv(claudeCodexSupportEnv, "true")
		if err := validateEditor("vim"); err == nil {
			t.Fatalf("expected unknown editor to be rejected")
		}
	})

	for _, editor := range []string{"claude", "codex"} {
		t.Run(editor+" gated off by default", func(t *testing.T) {
			t.Setenv(claudeCodexSupportEnv, "")
			if err := validateEditor(editor); err == nil {
				t.Fatalf("expected %q to be gated when the flag is unset", editor)
			}
		})
		t.Run(editor+" enabled when flag is true", func(t *testing.T) {
			t.Setenv(claudeCodexSupportEnv, "true")
			if err := validateEditor(editor); err != nil {
				t.Fatalf("expected %q to be allowed when flag is set: %v", editor, err)
			}
		})
		t.Run(editor+" gated when flag is a non-true value", func(t *testing.T) {
			t.Setenv(claudeCodexSupportEnv, "1")
			if err := validateEditor(editor); err == nil {
				t.Fatalf("expected %q to be gated when flag is %q", editor, "1")
			}
		})
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
