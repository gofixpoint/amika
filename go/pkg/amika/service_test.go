package amika

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/go/internal/sandbox"
)

func TestExtractRepoNamesFromMounts(t *testing.T) {
	workdir := sandbox.SandboxWorkdir
	cases := []struct {
		name   string
		mounts []Mount
		want   []string
	}{
		{
			name:   "no mounts",
			mounts: nil,
			want:   nil,
		},
		{
			name: "git mount under workspace",
			mounts: []Mount{
				{Target: workdir + "/amika"},
			},
			want: []string{"amika"},
		},
		{
			name: "ignores mounts outside workspace",
			mounts: []Mount{
				{Target: "/etc/foo"},
				{Target: "/usr/local/bin"},
			},
			want: nil,
		},
		{
			name: "ignores nested paths inside workspace",
			mounts: []Mount{
				{Target: workdir + "/amika/internal"},
			},
			want: nil,
		},
		{
			name: "ignores duplicate repo names",
			mounts: []Mount{
				{Target: workdir + "/amika"},
				{Target: workdir + "/amika"},
			},
			want: []string{"amika"},
		},
		{
			name: "preserves order across multiple repos",
			mounts: []Mount{
				{Target: workdir + "/alpha"},
				{Target: workdir + "/beta"},
			},
			want: []string{"alpha", "beta"},
		},
		{
			name: "handles trailing slash on direct child mount",
			mounts: []Mount{
				{Target: workdir + "/amika/"},
			},
			want: []string{"amika"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractRepoNamesFromMounts(tc.mounts)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestNewService_ReturnsService(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	if svc == nil {
		t.Fatal("expected service, got nil")
	}
	if _, err := svc.ListSandboxes(context.Background(), ListSandboxesRequest{}); err != nil {
		t.Fatalf("ListSandboxes err = %v", err)
	}
}

func TestNewService_InitFailureMapsToDependencyError(t *testing.T) {
	f := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(f, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMIKA_STATE_DIRECTORY", f)
	svc := NewService(Options{})
	_, err := svc.ListSandboxes(context.Background(), ListSandboxesRequest{})
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("expected internal error, got %v", err)
	}
}

func TestCreateSandbox_InvalidProvider(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{Provider: "podman"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestCreateSandbox_DuplicateName(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(sandbox.Info{Name: "dup", Provider: "docker"}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{Provider: "docker", Name: "dup"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestCreateSandbox_SetupScriptAndTextMutuallyExclusive(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{
		Provider:        "docker",
		Name:            "sb",
		SetupScript:     "/tmp/setup.sh",
		SetupScriptText: "#!/usr/bin/env bash\necho hi\n",
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestResolveSetupScriptMount_SetupScriptTextCreatesExecutableFile(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	mount, cleanup, err := resolveSetupScriptMount("sb", "", "#!/usr/bin/env bash\necho hi\n")
	if err != nil {
		t.Fatalf("resolveSetupScriptMount err = %v", err)
	}
	defer cleanup()
	if mount == nil {
		t.Fatal("expected mount, got nil")
	}

	info, err := os.Stat(mount.Source)
	if err != nil {
		t.Fatalf("stat setup script err = %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("expected setup script mode 0755, got %04o", info.Mode().Perm())
	}
}

func TestCreateSandbox_InvalidPortBinding(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{
		Provider: "docker",
		Name:     "sb",
		Image:    "img",
		Ports: []PortBinding{
			{HostPort: 0, ContainerPort: 80, Protocol: "tcp"},
		},
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestCreateSandbox_ReservedContainerPort(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	for _, port := range []int{60899, 60998, 60999} {
		_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{
			Provider: "docker",
			Name:     "sb",
			Image:    "img",
			Ports: []PortBinding{
				{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: port, Protocol: "tcp"},
			},
		})
		if !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("container port %d: expected invalid argument, got %v", port, err)
		}
	}
}

func TestCreateSandbox_DuplicatePortBinding(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{
		Provider: "docker",
		Name:     "sb",
		Image:    "img",
		Ports: []PortBinding{
			{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"},
			{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 8080, Protocol: "tcp"},
		},
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestDeleteSandbox_NotFound(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.DeleteSandbox(context.Background(), DeleteSandboxRequest{Names: []string{"missing"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestConnectSandbox_Validation(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	if err := svc.ConnectSandbox(context.Background(), ConnectSandboxRequest{}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
	if err := svc.ConnectSandbox(context.Background(), ConnectSandboxRequest{Name: "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestMaterialize_RequiresDestdir(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.Materialize(context.Background(), MaterializeRequest{Cmd: "echo hi"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestParseGitRepoURL(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		wantName string
		wantErr  bool
	}{
		{name: "https with .git", input: "https://github.com/octocat/Hello-World.git", wantName: "Hello-World"},
		{name: "https without .git", input: "https://github.com/octocat/Hello-World", wantName: "Hello-World"},
		{name: "http", input: "http://example.com/repo.git", wantName: "repo"},
		{name: "ssh scheme", input: "ssh://git@github.com/org/proj.git", wantName: "proj"},
		{name: "file absolute", input: "file:///home/user/myrepo.git", wantName: "myrepo"},
		{name: "file relative rejected", input: "file://relative/path", wantErr: true},
		{name: "scp style with user", input: "git@github.com:org/proj.git", wantName: "proj"},
		{name: "scp style no user", input: "github.com:proj.git", wantName: "proj"},
		{name: "unknown scheme", input: "ftp://example.com/repo.git", wantErr: true},
		{name: "empty", input: "", wantErr: true},
		{name: "bare path no colon", input: "/local/path/repo", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseGitRepoURL(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got name=%q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.wantName {
				t.Fatalf("got %q, want %q", got, tc.wantName)
			}
		})
	}
}

func TestDeleteVolume_NotFound(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.DeleteVolume(context.Background(), DeleteVolumeRequest{Names: []string{"missing"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}
