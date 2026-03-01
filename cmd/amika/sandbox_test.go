package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
)

func TestParseMountFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single mount with mode",
			flags:   []string{"/host/src:/workspace:ro"},
			wantLen: 1,
		},
		{
			name:    "single mount default mode",
			flags:   []string{"/host/src:/workspace"},
			wantLen: 1,
		},
		{
			name:    "multiple mounts",
			flags:   []string{"/a:/x:ro", "/b:/y:rw"},
			wantLen: 2,
		},
		{
			name:    "no mounts",
			flags:   nil,
			wantLen: 0,
		},
		{
			name:    "missing target",
			flags:   []string{"/host/src"},
			wantErr: true,
		},
		{
			name:    "invalid mode",
			flags:   []string{"/host/src:/workspace:xx"},
			wantErr: true,
		},
		{
			name:    "relative target rejected",
			flags:   []string{"/host/src:workspace:ro"},
			wantErr: true,
		},
		{
			name:    "duplicate target",
			flags:   []string{"/a:/workspace:ro", "/b:/workspace:rw"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mounts, err := parseMountFlags(tt.flags)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(mounts) != tt.wantLen {
				t.Errorf("expected %d mounts, got %d", tt.wantLen, len(mounts))
			}
		})
	}
}

func TestParseMountFlags_DefaultMode(t *testing.T) {
	mounts, err := parseMountFlags([]string{"/host/src:/workspace"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mounts[0].Mode != "rwcopy" {
		t.Errorf("mode = %q, want %q", mounts[0].Mode, "rwcopy")
	}
}

func TestParseMountFlags_ResolvesAbsPath(t *testing.T) {
	mounts, err := parseMountFlags([]string{"./relative:/workspace"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mounts[0].Source == "./relative" {
		t.Error("source should have been resolved to absolute path")
	}
}

func TestParseVolumeFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single volume with mode",
			flags:   []string{"vol1:/workspace:ro"},
			wantLen: 1,
		},
		{
			name:    "single volume default mode",
			flags:   []string{"vol1:/workspace"},
			wantLen: 1,
		},
		{
			name:    "missing target",
			flags:   []string{"vol1"},
			wantErr: true,
		},
		{
			name:    "empty name",
			flags:   []string{":/workspace:rw"},
			wantErr: true,
		},
		{
			name:    "invalid mode",
			flags:   []string{"vol1:/workspace:rwcopy"},
			wantErr: true,
		},
		{
			name:    "relative target rejected",
			flags:   []string{"vol1:workspace:rw"},
			wantErr: true,
		},
		{
			name:    "duplicate target",
			flags:   []string{"vol1:/workspace:ro", "vol2:/workspace:rw"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mounts, err := parseVolumeFlags(tt.flags)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(mounts) != tt.wantLen {
				t.Errorf("expected %d mounts, got %d", tt.wantLen, len(mounts))
			}
		})
	}
}

func TestValidateMountTargets_DuplicateAcrossMountAndVolume(t *testing.T) {
	bind := []sandbox.MountBinding{{Type: "bind", Source: "/host/src", Target: "/workspace", Mode: "rwcopy"}}
	vol := []sandbox.MountBinding{{Type: "volume", Volume: "vol1", Target: "/workspace", Mode: "rw"}}

	if err := validateMountTargets(bind, vol); err == nil {
		t.Fatal("expected duplicate target error")
	}
}

func TestCleanupSandboxVolumes_PreserveDefault(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", false, func(string) error {
		t.Fatal("removeVolumeFn should not be called in preserve mode")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteUnused(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	called := 0
	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(name string) error {
		called++
		if name != "vol-1" {
			t.Fatalf("unexpected volume: %s", name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if called != 1 {
		t.Fatalf("removeVolumeFn called %d times, want 1", called)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
	if _, err := store.Get("vol-1"); err == nil {
		t.Fatal("volume state entry should be removed")
	}
}

func TestCleanupSandboxVolumes_PreserveStillReferenced(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		t.Fatal("removeVolumeFn should not be called for still-referenced volume")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved (still referenced)" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 1 || info.SandboxRefs[0] != "sb-2" {
		t.Fatalf("SandboxRefs = %v, want [sb-2]", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteFailureReported(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		return fmt.Errorf("boom")
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: delete-failed: boom" {
		t.Fatalf("lines = %v", lines)
	}
}

func TestValidateGitFlags(t *testing.T) {
	if err := validateGitFlags(false, true); err == nil {
		t.Fatal("expected error when --no-clean is used without --git")
	}
	if err := validateGitFlags(true, true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResolveGitRoot(t *testing.T) {
	t.Run("finds from nested directory", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, ".git"), 0755); err != nil {
			t.Fatalf("failed to create .git directory: %v", err)
		}
		nested := filepath.Join(root, "a", "b")
		if err := os.MkdirAll(nested, 0755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}

		got, err := resolveGitRoot(nested)
		if err != nil {
			t.Fatalf("resolveGitRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("accepts .git file", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /tmp/worktree"), 0644); err != nil {
			t.Fatalf("failed to create .git file: %v", err)
		}
		nested := filepath.Join(root, "nested")
		if err := os.MkdirAll(nested, 0755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}

		got, err := resolveGitRoot(nested)
		if err != nil {
			t.Fatalf("resolveGitRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("handles file path input", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, ".git"), 0755); err != nil {
			t.Fatalf("failed to create .git directory: %v", err)
		}
		filePath := filepath.Join(root, "nested", "file.txt")
		if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}
		if err := os.WriteFile(filePath, []byte("x"), 0644); err != nil {
			t.Fatalf("failed to write file: %v", err)
		}

		got, err := resolveGitRoot(filePath)
		if err != nil {
			t.Fatalf("resolveGitRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("errors when repo is not found", func(t *testing.T) {
		dir := t.TempDir()
		_, err := resolveGitRoot(dir)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "no git repository root found") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestPrepareGitMount_NoClean(t *testing.T) {
	root := createGitRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
	untracked := filepath.Join(root, "local.txt")
	if err := os.WriteFile(untracked, []byte("untracked"), 0644); err != nil {
		t.Fatalf("failed to create untracked file: %v", err)
	}

	info, cleanup, err := prepareGitMount(root, true, func(_, _ string) error {
		t.Fatal("cloneFn should not be called in --no-clean mode")
		return nil
	})
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	if info.Mount.Source == root {
		t.Fatal("source should be a prepared temp repo, not host repo")
	}
	wantTarget := "/home/amika/workspace/" + filepath.Base(root)
	if info.Mount.Target != wantTarget {
		t.Fatalf("target = %q, want %q", info.Mount.Target, wantTarget)
	}
	if info.Mount.Mode != "rwcopy" {
		t.Fatalf("mode = %q, want rwcopy", info.Mount.Mode)
	}
	if _, err := os.Stat(filepath.Join(info.Mount.Source, "local.txt")); err != nil {
		t.Fatalf("expected untracked file in prepared repo: %v", err)
	}
}

func TestPrepareGitMount_CleanClone(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
		"local":  "/tmp/local-path",
	})

	var clonedSrc, clonedDst string
	info, cleanup, err := prepareGitMount(root, false, func(src, dst string) error {
		clonedSrc = src
		clonedDst = dst
		cmd := exec.Command("git", "clone", "--local", "--no-hardlinks", src, dst)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("clone failed: %s", out)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	if clonedSrc != root {
		t.Fatalf("clone source = %q, want %q", clonedSrc, root)
	}
	if clonedDst == "" {
		t.Fatal("expected clone destination to be set")
	}
	if info.Mount.Source != clonedDst {
		t.Fatalf("mount source = %q, want clone destination %q", info.Mount.Source, clonedDst)
	}
	gotRemotes := readGitRemotes(t, clonedDst)
	wantRemotes := map[string]string{"origin": "https://github.com/example/upstream.git"}
	if !reflect.DeepEqual(gotRemotes, wantRemotes) {
		t.Fatalf("prepared remotes = %#v, want %#v", gotRemotes, wantRemotes)
	}

	cleanup()
	if _, err := os.Stat(filepath.Dir(clonedDst)); !os.IsNotExist(err) {
		t.Fatalf("expected temp git clone directory to be removed, err=%v", err)
	}
}

func TestSyncGitRemotes(t *testing.T) {
	src := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
		"fork":   "git@github.com:example/fork.git",
		"local":  "/Users/dbmikus/workspace/github.com/example/repo",
		"file":   "file:///Users/dbmikus/workspace/github.com/example/repo",
	})
	dst := createGitRepo(t, map[string]string{
		"origin": "/tmp/source-repo",
		"other":  "ssh://git@internal.example.com/repo.git",
	})

	if err := syncGitRemotes(src, dst); err != nil {
		t.Fatalf("syncGitRemotes failed: %v", err)
	}

	got := readGitRemotes(t, dst)
	want := map[string]string{
		"fork":   "git@github.com:example/fork.git",
		"origin": "https://github.com/example/upstream.git",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("remotes = %#v, want %#v", got, want)
	}
}

func TestIsNetworkRemoteURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{url: "https://github.com/org/repo.git", want: true},
		{url: "http://github.com/org/repo.git", want: true},
		{url: "ssh://git@github.com/org/repo.git", want: true},
		{url: "git@github.com:org/repo.git", want: true},
		{url: "/Users/me/repo", want: false},
		{url: "../repo", want: false},
		{url: "file:///Users/me/repo", want: false},
	}
	for _, tt := range tests {
		if got := isNetworkRemoteURL(tt.url); got != tt.want {
			t.Fatalf("isNetworkRemoteURL(%q) = %v, want %v", tt.url, got, tt.want)
		}
	}
}

func TestPromptForConfirmation(t *testing.T) {
	t.Run("yes", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("y\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !ok {
			t.Fatal("expected confirmation")
		}
	})

	t.Run("no", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("n\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if ok {
			t.Fatal("expected rejection")
		}
	})

	t.Run("blank then yes reprompts", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("\nYES\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !ok {
			t.Fatal("expected confirmation after reprompt")
		}
	})

	t.Run("invalid then no reprompts", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("maybe\nno\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if ok {
			t.Fatal("expected rejection after reprompt")
		}
	})
}

func createGitRepo(t *testing.T, remotes map[string]string) string {
	t.Helper()

	root := t.TempDir()
	runGitCmd(t, root, "init")
	runGitCmd(t, root, "config", "user.name", "Test User")
	runGitCmd(t, root, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("test\n"), 0644); err != nil {
		t.Fatalf("failed to write README: %v", err)
	}
	runGitCmd(t, root, "add", "README.md")
	runGitCmd(t, root, "commit", "-m", "init")

	names := make([]string, 0, len(remotes))
	for name := range remotes {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		runGitCmd(t, root, "remote", "add", name, remotes[name])
	}
	return root
}

func readGitRemotes(t *testing.T, repo string) map[string]string {
	t.Helper()
	remotes, err := listGitRemotes(repo)
	if err != nil {
		t.Fatalf("listGitRemotes(%q) failed: %v", repo, err)
	}
	return remotes
}

func runGitCmd(t *testing.T, repo string, args ...string) {
	t.Helper()
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, out)
	}
}
