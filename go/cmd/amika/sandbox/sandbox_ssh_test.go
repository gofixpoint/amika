package sandboxcmd

import (
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

func TestResolveCursorRemotePath(t *testing.T) {
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
			got := resolveCursorRemotePath(tt.repoName, tt.pathOverride)
			if got != tt.want {
				t.Errorf("resolveCursorRemotePath(%q, %q) = %q, want %q",
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

func (s *stubSSHClient) GetSSH(_ string) (*apiclient.SSHInfo, error) {
	return s.info, nil
}

func (s *stubSSHClient) GetSandbox(_ string) (*apiclient.RemoteSandbox, error) {
	return s.sandbox, nil
}

func testSSHPaths(t *testing.T) basedir.Paths {
	t.Helper()
	home := t.TempDir()
	t.Setenv("XDG_STATE_HOME", filepath.Join(t.TempDir(), "state"))
	return basedir.New(home)
}

func TestPrepareCursorSSHTarget(t *testing.T) {
	tests := []struct {
		name         string
		info         *apiclient.SSHInfo
		pathOverride string
		wantAlias    string
		wantPath     string
	}{
		{
			name: "default path with repo",
			info: &apiclient.SSHInfo{
				SSHDestination: "-p 2222 tok@ssh.app.daytona.io",
				SandboxID:      "sb_abc",
				SandboxName:    "my-sandbox",
				RepoName:       "biz",
			},
			wantAlias: "amika-sb_abc",
			wantPath:  "/home/amika/workspace/biz",
		},
		{
			name: "default path without repo",
			info: &apiclient.SSHInfo{
				SSHDestination: "-p 2222 tok@ssh.app.daytona.io",
				SandboxID:      "sb_abc",
				SandboxName:    "my-sandbox",
			},
			wantAlias: "amika-sb_abc",
			wantPath:  "/home/amika/workspace",
		},
		{
			name: "relative path override",
			info: &apiclient.SSHInfo{
				SSHDestination: "-p 2222 tok@ssh.app.daytona.io",
				SandboxID:      "sb_abc",
				SandboxName:    "my-sandbox",
				RepoName:       "biz",
			},
			pathOverride: "workspace/biz",
			wantAlias:    "amika-sb_abc",
			wantPath:     "/home/amika/workspace/biz",
		},
		{
			name: "absolute path override",
			info: &apiclient.SSHInfo{
				SSHDestination: "-p 2222 tok@ssh.app.daytona.io",
				SandboxID:      "sb_abc",
				SandboxName:    "my-sandbox",
				RepoName:       "biz",
			},
			pathOverride: "/custom/path",
			wantAlias:    "amika-sb_abc",
			wantPath:     "/custom/path",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := &stubSSHClient{info: tt.info}
			got, err := prepareCursorSSHTarget(client, testSSHPaths(t), "my-sandbox", tt.pathOverride)
			if err != nil {
				t.Fatalf("prepareCursorSSHTarget: %v", err)
			}
			if got.alias != tt.wantAlias {
				t.Errorf("alias = %q, want %q", got.alias, tt.wantAlias)
			}
			if got.remotePath != tt.wantPath {
				t.Errorf("remotePath = %q, want %q", got.remotePath, tt.wantPath)
			}
		})
	}
}
