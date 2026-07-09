package eventlog

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestGatherGit_NotARepo(t *testing.T) {
	if got := GatherGit(t.TempDir()); got != nil {
		t.Fatalf("GatherGit(non-repo) = %+v, want nil", got)
	}
	if got := GatherGit(""); got != nil {
		t.Fatalf("GatherGit(\"\") = %+v, want nil", got)
	}
}

func TestGatherGit_CommitBranchDirty(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	writeFile(t, filepath.Join(dir, "a.txt"), "hello")
	runGit(t, dir, "add", "a.txt")
	runGit(t, dir, "commit", "-m", "initial")

	got := GatherGit(dir)
	if got == nil {
		t.Fatal("GatherGit(repo) = nil, want info")
	}
	// RepoRoot may be reported via a symlink-resolved path (e.g. /private on
	// macOS), so compare basenames rather than the full path.
	if filepath.Base(got.RepoRoot) != filepath.Base(dir) {
		t.Errorf("RepoRoot = %q, want basename %q", got.RepoRoot, filepath.Base(dir))
	}
	if len(got.Commit) != 40 {
		t.Errorf("Commit = %q, want a 40-char sha", got.Commit)
	}
	if got.Branch != "main" {
		t.Errorf("Branch = %q, want main", got.Branch)
	}
	if got.Dirty {
		t.Error("Dirty = true on a clean tree, want false")
	}

	writeFile(t, filepath.Join(dir, "untracked.txt"), "x")
	if got := GatherGit(dir); got == nil || !got.Dirty {
		t.Errorf("Dirty = %v, want true after adding untracked file", got)
	}
}

func TestGatherGit_Remote(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	runGit(t, dir, "remote", "add", "origin", "git@github.com:fixpoint/amika.git")

	got := GatherGit(dir)
	if got == nil {
		t.Fatal("GatherGit(repo) = nil, want info")
	}
	if got.Remote != "github.com/fixpoint/amika" {
		t.Errorf("Remote = %q, want github.com/fixpoint/amika", got.Remote)
	}
}

func TestGatherGit_NoRemote(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	initRepo(t, dir)
	if got := GatherGit(dir); got == nil || got.Remote != "" {
		t.Errorf("Remote = %v, want empty for a repo with no origin remote", got)
	}
}

func TestNormalizeRemoteURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"https://github.com/fixpoint/amika.git", "github.com/fixpoint/amika"},
		{"https://github.com/fixpoint/amika", "github.com/fixpoint/amika"},
		{"http://github.com/fixpoint/amika.git", "github.com/fixpoint/amika"},
		{"git@github.com:fixpoint/amika.git", "github.com/fixpoint/amika"},
		{"git@github.com:fixpoint/amika", "github.com/fixpoint/amika"},
		{"ssh://git@github.com/fixpoint/amika.git", "github.com/fixpoint/amika"},
		{"ssh://git@github.com:22/fixpoint/amika.git", "github.com/fixpoint/amika"},
		{"git://github.com/fixpoint/amika.git", "github.com/fixpoint/amika"},
		{"https://user:token@gitlab.example.com/group/sub/proj.git", "gitlab.example.com/group/sub/proj"},
		{"https://github.com/Fixpoint/Amika.git", "github.com/Fixpoint/Amika"}, // case preserved; lowercased at key-build time
		{"  https://github.com/fixpoint/amika.git  ", "github.com/fixpoint/amika"},
		{"", ""},
		{"file:///home/u/work/amika", ""}, // local remote has no host/owner/repo identity
		{"/home/u/work/amika", ""},        // bare local path
		{"https://github.com", ""},        // host only, no path
	}
	for _, c := range cases {
		if got := normalizeRemoteURL(c.in); got != c.want {
			t.Errorf("normalizeRemoteURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

// initRepo creates a git repo with a deterministic default branch and an
// isolated config so the host's global git settings cannot affect the test.
func initRepo(t *testing.T, dir string) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(t.TempDir(), "nonexistent-global"))
	t.Setenv("GIT_CONFIG_SYSTEM", filepath.Join(t.TempDir(), "nonexistent-system"))
	runGit(t, dir, "-c", "init.defaultBranch=main", "init")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test User")
	runGit(t, dir, "config", "commit.gpgsign", "false")
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
