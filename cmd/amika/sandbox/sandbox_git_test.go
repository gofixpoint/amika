package sandboxcmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/amikaconfig"
)

func TestResolveGitRoot(t *testing.T) {
	t.Run("finds from nested directory", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
			t.Fatalf("failed to create .git directory: %v", err)
		}
		nested := filepath.Join(root, "a", "b")
		if err := os.MkdirAll(nested, 0o755); err != nil {
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
		if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /tmp/worktree"), 0o644); err != nil {
			t.Fatalf("failed to create .git file: %v", err)
		}
		nested := filepath.Join(root, "nested")
		if err := os.MkdirAll(nested, 0o755); err != nil {
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
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
			t.Fatalf("failed to create .git directory: %v", err)
		}
		filePath := filepath.Join(root, "nested", "file.txt")
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}
		if err := os.WriteFile(filePath, []byte("x"), 0o644); err != nil {
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
	if err := os.WriteFile(untracked, []byte("untracked"), 0o644); err != nil {
		t.Fatalf("failed to create untracked file: %v", err)
	}

	info, cleanup, err := prepareGitMount(root, true, func(_, _ string) error {
		t.Fatal("cloneFn should not be called in --no-clean mode")
		return nil
	}, "", "")
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
	}, "", "")
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

func TestPrepareGitMount_CleanClone_ChecksOutRemoteTrackingBranch(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	defaultBranch := gitCurrentBranch(t, root)
	runGitCmd(t, root, "checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(root, "feature.txt"), []byte("feature\n"), 0o644); err != nil {
		t.Fatalf("failed to write feature file: %v", err)
	}
	runGitCmd(t, root, "add", "feature.txt")
	runGitCmd(t, root, "commit", "-m", "feature commit")
	featureCommit := gitRevParse(t, root, "HEAD")
	runGitCmd(t, root, "checkout", defaultBranch)

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "feature", "")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != featureCommit {
		t.Fatalf("HEAD = %q, want feature commit %q", gotCommit, featureCommit)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "feature" {
		t.Fatalf("branch = %q, want %q", gotBranch, "feature")
	}
}

func TestPrepareGitMount_CleanClone_NewBranchUsesHostBranch(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	if err := os.WriteFile(filepath.Join(root, "default.txt"), []byte("default\n"), 0o644); err != nil {
		t.Fatalf("failed to write default-branch file: %v", err)
	}
	runGitCmd(t, root, "add", "default.txt")
	runGitCmd(t, root, "commit", "-m", "default branch commit")

	runGitCmd(t, root, "checkout", "-b", "work")
	if err := os.WriteFile(filepath.Join(root, "work.txt"), []byte("work\n"), 0o644); err != nil {
		t.Fatalf("failed to write work file: %v", err)
	}
	runGitCmd(t, root, "add", "work.txt")
	runGitCmd(t, root, "commit", "-m", "work commit")
	workCommit := gitRevParse(t, root, "HEAD")

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "", "topic")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "topic" {
		t.Fatalf("branch = %q, want %q", gotBranch, "topic")
	}

	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != workCommit {
		t.Fatalf("HEAD = %q, want work commit %q", gotCommit, workCommit)
	}
}

func TestPrepareGitMount_CleanClone_NewBranchFromHostBranch(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	if err := os.WriteFile(filepath.Join(root, "default.txt"), []byte("default\n"), 0o644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGitCmd(t, root, "add", "default.txt")
	runGitCmd(t, root, "commit", "-m", "default branch commit")

	runGitCmd(t, root, "checkout", "-b", "work")
	if err := os.WriteFile(filepath.Join(root, "work.txt"), []byte("work\n"), 0o644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGitCmd(t, root, "add", "work.txt")
	runGitCmd(t, root, "commit", "-m", "work commit")
	workCommit := gitRevParse(t, root, "HEAD")

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "", "topic")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "topic" {
		t.Fatalf("branch = %q, want %q", gotBranch, "topic")
	}

	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != workCommit {
		t.Fatalf("HEAD = %q, want work commit %q", gotCommit, workCommit)
	}
}

func TestPrepareGitMount_CleanClone_BranchAndNewBranchCreatesBase(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	defaultCommit := gitRevParse(t, root, "HEAD")

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "feat-1", "feat-1-fix")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "feat-1-fix" {
		t.Fatalf("branch = %q, want %q", gotBranch, "feat-1-fix")
	}

	if !localBranchExists(info.Mount.Source, "feat-1") {
		t.Fatal("expected local branch feat-1 to exist")
	}

	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != defaultCommit {
		t.Fatalf("HEAD = %q, want default commit %q", gotCommit, defaultCommit)
	}
}

func TestConfigReadFromPreparedRepo(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	defaultBranch := gitCurrentBranch(t, root)

	amikaDir := filepath.Join(root, ".amika")
	if err := os.MkdirAll(amikaDir, 0o755); err != nil {
		t.Fatalf("failed to create .amika dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.sh"), []byte("#!/bin/sh\necho main\n"), 0o755); err != nil {
		t.Fatalf("failed to write main setup script: %v", err)
	}
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte("[lifecycle]\nsetup_script = \"main.sh\"\n"), 0o644); err != nil {
		t.Fatalf("failed to write config.toml: %v", err)
	}
	runGitCmd(t, root, "add", ".amika/config.toml", "main.sh")
	runGitCmd(t, root, "commit", "-m", "add config on default branch")

	runGitCmd(t, root, "checkout", "-b", "other")
	if err := os.WriteFile(filepath.Join(root, "other.sh"), []byte("#!/bin/sh\necho other\n"), 0o755); err != nil {
		t.Fatalf("failed to write other setup script: %v", err)
	}
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte("[lifecycle]\nsetup_script = \"other.sh\"\n"), 0o644); err != nil {
		t.Fatalf("failed to write config.toml: %v", err)
	}
	runGitCmd(t, root, "add", ".amika/config.toml", "other.sh")
	runGitCmd(t, root, "commit", "-m", "change config on other")

	runGitCmd(t, root, "checkout", defaultBranch)

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "other", "")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	preparedCfg, err := amikaconfig.LoadConfig(info.Mount.Source)
	if err != nil {
		t.Fatalf("LoadConfig from prepared repo failed: %v", err)
	}
	if preparedCfg == nil || preparedCfg.Lifecycle.SetupScript != "other.sh" {
		var got string
		if preparedCfg != nil {
			got = preparedCfg.Lifecycle.SetupScript
		}
		t.Fatalf("prepared repo setup_script = %q, want %q", got, "other.sh")
	}

	hostCfg, err := amikaconfig.LoadConfig(info.RepoRoot)
	if err != nil {
		t.Fatalf("LoadConfig from host repo failed: %v", err)
	}
	if hostCfg == nil || hostCfg.Lifecycle.SetupScript != "main.sh" {
		var got string
		if hostCfg != nil {
			got = hostCfg.Lifecycle.SetupScript
		}
		t.Fatalf("host repo setup_script = %q, want %q", got, "main.sh")
	}

	if preparedCfg.Lifecycle.SetupScript == hostCfg.Lifecycle.SetupScript {
		t.Fatal("expected prepared and host configs to differ")
	}

	mount, err := setupScriptMountFromLoadedConfig(preparedCfg, info.Mount.Source)
	if err != nil {
		t.Fatalf("setupScriptMountFromLoadedConfig from prepared repo failed: %v", err)
	}
	if mount == nil {
		t.Fatal("expected setup script mount from prepared repo")
	}
	wantPreparedPath := filepath.Join(info.Mount.Source, "other.sh")
	if mount.Source != wantPreparedPath {
		t.Fatalf("prepared setup script source = %q, want %q", mount.Source, wantPreparedPath)
	}

	hostMount, err := setupScriptMountFromLoadedConfig(hostCfg, info.RepoRoot)
	if err != nil {
		t.Fatalf("setupScriptMountFromLoadedConfig from host repo failed: %v", err)
	}
	if hostMount == nil {
		t.Fatal("expected setup script mount from host repo")
	}
	wantHostPath := filepath.Join(info.RepoRoot, "main.sh")
	if hostMount.Source != wantHostPath {
		t.Fatalf("host setup script source = %q, want %q", hostMount.Source, wantHostPath)
	}
	if mount.Source == hostMount.Source {
		t.Fatal("expected prepared and host setup script sources to differ")
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

func TestIsLocalBranchReachableFromRemote(t *testing.T) {
	// Set up a bare repo to act as "origin" and a working clone.
	bare := t.TempDir()
	runGitCmd(t, bare, "init", "--bare")

	work := filepath.Join(t.TempDir(), "work")
	cmd := exec.Command("git", "clone", bare, work)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("clone failed: %s", out)
	}
	runGitCmd(t, work, "config", "user.name", "Test User")
	runGitCmd(t, work, "config", "user.email", "test@example.com")

	// Initial commit and push.
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitCmd(t, work, "add", "a.txt")
	runGitCmd(t, work, "commit", "-m", "c1")
	runGitCmd(t, work, "push", "origin", "HEAD")

	branch := gitCurrentBranch(t, work)

	t.Run("exact match returns true", func(t *testing.T) {
		if !isLocalBranchReachableFromRemote(work, branch) {
			t.Fatal("expected true when local matches remote")
		}
	})

	// Push another commit, then reset local back so remote is ahead.
	if err := os.WriteFile(filepath.Join(work, "b.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitCmd(t, work, "add", "b.txt")
	runGitCmd(t, work, "commit", "-m", "c2")
	runGitCmd(t, work, "push", "origin", "HEAD")
	runGitCmd(t, work, "reset", "--hard", "HEAD~1")

	t.Run("local behind remote returns true", func(t *testing.T) {
		if !isLocalBranchReachableFromRemote(work, branch) {
			t.Fatal("expected true when local is ancestor of remote")
		}
	})

	// Create a divergent local commit (local is no longer an ancestor of remote).
	if err := os.WriteFile(filepath.Join(work, "c.txt"), []byte("c\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitCmd(t, work, "add", "c.txt")
	runGitCmd(t, work, "commit", "-m", "c3-diverged")

	t.Run("local diverged returns false", func(t *testing.T) {
		if isLocalBranchReachableFromRemote(work, branch) {
			t.Fatal("expected false when local has diverged from remote")
		}
	})

	t.Run("branch not on remote returns false", func(t *testing.T) {
		runGitCmd(t, work, "checkout", "-b", "no-remote")
		if isLocalBranchReachableFromRemote(work, "no-remote") {
			t.Fatal("expected false when branch does not exist on remote")
		}
	})
}

func createGitRepo(t *testing.T, remotes map[string]string) string {
	t.Helper()

	root := t.TempDir()
	runGitCmd(t, root, "init")
	runGitCmd(t, root, "config", "user.name", "Test User")
	runGitCmd(t, root, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("test\n"), 0o644); err != nil {
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

func gitRevParse(t *testing.T, repo string, rev string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", rev)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse %s failed: %v\n%s", rev, err, out)
	}
	return strings.TrimSpace(string(out))
}

func gitCurrentBranch(t *testing.T, repo string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse --abbrev-ref HEAD failed: %v\n%s", err, out)
	}
	return strings.TrimSpace(string(out))
}
