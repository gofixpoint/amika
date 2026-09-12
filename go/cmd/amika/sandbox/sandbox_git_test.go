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

	"github.com/gofixpoint/amika/go/internal/amikaconfig"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
)

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

func TestPrepareGitMountFromURL(t *testing.T) {
	source := createGitRepo(t, nil)
	fakeURL := "https://example.com/foo/myrepo.git"

	var seenSrc, seenDst string
	cloneFn := func(src, dst string) error {
		seenSrc = src
		seenDst = dst
		cmd := exec.Command("git", "clone", "--local", "--no-hardlinks", source, dst)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("clone failed: %s", out)
		}
		return nil
	}

	info, cleanup, err := prepareGitMountFromURL(fakeURL, cloneFn, "", "")
	if err != nil {
		t.Fatalf("prepareGitMountFromURL failed: %v", err)
	}
	defer cleanup()

	if seenSrc != fakeURL {
		t.Fatalf("cloneFn src = %q, want %q", seenSrc, fakeURL)
	}
	if seenDst != info.Mount.Source {
		t.Fatalf("cloneFn dst = %q, want %q", seenDst, info.Mount.Source)
	}
	if info.RepoName != "myrepo" {
		t.Fatalf("RepoName = %q, want %q", info.RepoName, "myrepo")
	}
	if info.RepoRoot != fakeURL {
		t.Fatalf("RepoRoot = %q, want %q", info.RepoRoot, fakeURL)
	}
	wantTarget := "/home/amika/workspace/myrepo"
	if info.Mount.Target != wantTarget {
		t.Fatalf("Mount.Target = %q, want %q", info.Mount.Target, wantTarget)
	}
	if info.Mount.Mode != "rwcopy" {
		t.Fatalf("Mount.Mode = %q, want rwcopy", info.Mount.Mode)
	}
	if info.Mount.SnapshotFrom != fakeURL {
		t.Fatalf("Mount.SnapshotFrom = %q, want %q", info.Mount.SnapshotFrom, fakeURL)
	}
	if _, err := os.Stat(filepath.Join(info.Mount.Source, "README.md")); err != nil {
		t.Fatalf("expected README.md in cloned repo: %v", err)
	}

	tmpDir := filepath.Dir(info.Mount.Source)
	cleanup()
	if _, err := os.Stat(tmpDir); !os.IsNotExist(err) {
		t.Fatalf("expected temp git clone directory to be removed, err=%v", err)
	}
}

func TestPrepareGitMountFromURL_BadURL(t *testing.T) {
	cloneFn := func(_, _ string) error {
		t.Fatal("cloneFn should not be called for a bad URL")
		return nil
	}
	if _, _, err := prepareGitMountFromURL("", cloneFn, "", ""); err == nil {
		t.Fatal("expected error for empty URL")
	}
	if _, _, err := prepareGitMountFromURL("https://github.com/", cloneFn, "", ""); err == nil {
		t.Fatal("expected error for URL without path")
	}
}

func TestPrepareGitMountFromURL_CloneFails(t *testing.T) {
	cloneFn := func(_, _ string) error {
		return fmt.Errorf("simulated clone failure")
	}
	_, _, err := prepareGitMountFromURL("https://example.com/foo/bar.git", cloneFn, "", "")
	if err == nil {
		t.Fatal("expected clone failure to surface")
	}
	if !strings.Contains(err.Error(), "simulated clone failure") {
		t.Fatalf("error = %v, want it to mention the clone failure", err)
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

func TestFormatRepoBanner(t *testing.T) {
	tests := []struct {
		name     string
		identity gitrepo.Identity
		want     string
	}{
		{
			name:     "none",
			identity: gitrepo.Identity{Source: gitrepo.SourceNone},
			want:     "Creating a bare sandbox with no repos.",
		},
		{
			name:     "auto-detect",
			identity: gitrepo.Identity{Source: gitrepo.SourceAutoDetect, Name: "myrepo"},
			want:     "Creating sandbox with repo myrepo.",
		},
		{
			name:     "flag-path",
			identity: gitrepo.Identity{Source: gitrepo.SourceFlagPath, Name: "frompath"},
			want:     "Creating sandbox with repo frompath.",
		},
		{
			name:     "flag-url",
			identity: gitrepo.Identity{Source: gitrepo.SourceFlagURL, Name: "fromurl"},
			want:     "Creating sandbox with repo fromurl.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatRepoBanner(tt.identity); got != tt.want {
				t.Fatalf("formatRepoBanner = %q, want %q", got, tt.want)
			}
		})
	}
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
	remotes, err := gitrepo.ListRemotes(repo)
	if err != nil {
		t.Fatalf("gitrepo.ListRemotes(%q) failed: %v", repo, err)
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
