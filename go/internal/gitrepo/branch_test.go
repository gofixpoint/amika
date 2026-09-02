package gitrepo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runGitIn runs a git command in dir and fails the test on error.
func runGitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %s", strings.Join(args, " "), out)
	}
}

// currentBranchOf reports the checked-out branch, for asserting fixture setup.
func currentBranchOf(t *testing.T, repo string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("current branch: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// revParse resolves a revision to its SHA.
func revParse(t *testing.T, repo, rev string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", rev)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-parse %s: %v", rev, err)
	}
	return strings.TrimSpace(string(out))
}

func TestBranchReachableFromRemote(t *testing.T) {
	// Set up a bare repo to act as "origin" and a working clone.
	bare := t.TempDir()
	runGitIn(t, bare, "init", "--bare")

	work := filepath.Join(t.TempDir(), "work")
	cmd := exec.Command("git", "clone", bare, work)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("clone failed: %s", out)
	}
	runGitIn(t, work, "config", "user.name", "Test User")
	runGitIn(t, work, "config", "user.email", "test@example.com")

	// Initial commit and push.
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitIn(t, work, "add", "a.txt")
	runGitIn(t, work, "commit", "-m", "c1")
	runGitIn(t, work, "push", "origin", "HEAD")

	branch := currentBranchOf(t, work)

	t.Run("exact match returns true", func(t *testing.T) {
		if !BranchReachableFromRemote(work, branch) {
			t.Fatal("expected true when local matches remote")
		}
	})

	// Push another commit, then reset local back so remote is ahead.
	if err := os.WriteFile(filepath.Join(work, "b.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitIn(t, work, "add", "b.txt")
	runGitIn(t, work, "commit", "-m", "c2")
	runGitIn(t, work, "push", "origin", "HEAD")
	runGitIn(t, work, "reset", "--hard", "HEAD~1")

	t.Run("local behind remote returns true", func(t *testing.T) {
		if !BranchReachableFromRemote(work, branch) {
			t.Fatal("expected true when local is ancestor of remote")
		}
	})

	// Create a divergent local commit (local is no longer an ancestor of remote).
	if err := os.WriteFile(filepath.Join(work, "c.txt"), []byte("c\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitIn(t, work, "add", "c.txt")
	runGitIn(t, work, "commit", "-m", "c3-diverged")

	t.Run("local diverged returns false", func(t *testing.T) {
		if BranchReachableFromRemote(work, branch) {
			t.Fatal("expected false when local has diverged from remote")
		}
	})

	t.Run("branch not on remote returns false", func(t *testing.T) {
		runGitIn(t, work, "checkout", "-b", "no-remote")
		if BranchReachableFromRemote(work, "no-remote") {
			t.Fatal("expected false when branch does not exist on remote")
		}
	})
}

// TestBranchReachableFromRemote_TrackingRefFallback exercises the
// fallback path where the remote SHA (from ls-remote) is NOT in the local
// object store. This happens when someone else pushes to the remote and the
// user hasn't fetched. The function should fall back to comparing against
// the last-fetched tracking ref (refs/remotes/origin/<branch>).
func TestBranchReachableFromRemote_TrackingRefFallback(t *testing.T) {
	bare := t.TempDir()
	runGitIn(t, bare, "init", "--bare")

	// First clone: "work" — the repo under test.
	work := filepath.Join(t.TempDir(), "work")
	cloneCmd := exec.Command("git", "clone", bare, work)
	if out, err := cloneCmd.CombinedOutput(); err != nil {
		t.Fatalf("clone failed: %s", out)
	}
	runGitIn(t, work, "config", "user.name", "Test User")
	runGitIn(t, work, "config", "user.email", "test@example.com")

	// Push an initial commit from work.
	if err := os.WriteFile(filepath.Join(work, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitIn(t, work, "add", "a.txt")
	runGitIn(t, work, "commit", "-m", "c1")
	runGitIn(t, work, "push", "origin", "HEAD")
	branch := currentBranchOf(t, work)

	// Second clone: "other" — simulates another contributor.
	other := filepath.Join(t.TempDir(), "other")
	cloneCmd2 := exec.Command("git", "clone", bare, other)
	if out, err := cloneCmd2.CombinedOutput(); err != nil {
		t.Fatalf("clone failed: %s", out)
	}
	runGitIn(t, other, "config", "user.name", "Other User")
	runGitIn(t, other, "config", "user.email", "other@example.com")

	// Push a new commit from "other" so the bare repo is ahead of "work".
	// "work" has never seen this commit — its object store does not contain
	// the new SHA.
	if err := os.WriteFile(filepath.Join(other, "b.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitIn(t, other, "add", "b.txt")
	runGitIn(t, other, "commit", "-m", "c2-from-other")
	runGitIn(t, other, "push", "origin", "HEAD")

	t.Run("local behind unfetched remote returns true via tracking ref", func(t *testing.T) {
		if !BranchReachableFromRemote(work, branch) {
			t.Fatal("expected true when local is behind remote and remote SHA is not in local store")
		}
	})

	// Now make a local commit in "work" so it has diverged from the remote.
	if err := os.WriteFile(filepath.Join(work, "c.txt"), []byte("c\n"), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	runGitIn(t, work, "add", "c.txt")
	runGitIn(t, work, "commit", "-m", "c3-local-only")

	t.Run("local ahead of tracking ref with unfetched remote returns false", func(t *testing.T) {
		if BranchReachableFromRemote(work, branch) {
			t.Fatal("expected false when local has unpushed commits and remote SHA is not in local store")
		}
	})
}

func TestResolveBranch(t *testing.T) {
	// pushedRepo builds a clone whose branch exists on its "origin", so the
	// reachability check passes; unpushed branches are made on top of it.
	pushedRepo := func(t *testing.T) string {
		t.Helper()
		bare := t.TempDir()
		runGitIn(t, bare, "init", "--bare")
		work := filepath.Join(t.TempDir(), "work")
		if out, err := exec.Command("git", "clone", bare, work).CombinedOutput(); err != nil {
			t.Fatalf("clone: %s", out)
		}
		runGitIn(t, work, "config", "user.email", "t@example.com")
		runGitIn(t, work, "config", "user.name", "T")
		runGitIn(t, work, "commit", "--allow-empty", "-m", "c1")
		runGitIn(t, work, "push", "-q", "origin", "HEAD")
		return work
	}
	local := func(path string) Identity {
		return Identity{Name: "repo", Source: SourceAutoDetect, Path: path}
	}

	t.Run("carries over the current branch when neither flag is given", func(t *testing.T) {
		repo := pushedRepo(t)
		want := currentBranchOf(t, repo)
		got, err := ResolveBranch(local(repo), BranchRequest{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != want {
			t.Fatalf("Branch = %q, want the checked-out %q", got.Branch, want)
		}
		if got.NewBranch != "" {
			t.Fatalf("NewBranch = %q, want empty", got.NewBranch)
		}
	})

	t.Run("refuses an inferred branch the remote does not have", func(t *testing.T) {
		// The whole point: the sandbox would come up on the default branch and
		// the agent would answer about code the caller cannot see.
		repo := pushedRepo(t)
		runGitIn(t, repo, "checkout", "-q", "-b", "unpushed")
		runGitIn(t, repo, "commit", "--allow-empty", "-m", "local only")
		_, err := ResolveBranch(local(repo), BranchRequest{})
		if err == nil || !strings.Contains(err.Error(), "has not been pushed") {
			t.Fatalf("err = %v, want an unpushed-branch refusal", err)
		}
	})

	t.Run("an explicit --branch is honored even when unpushed", func(t *testing.T) {
		// Naming a branch is a statement of intent; the server creates it if
		// the remote has none.
		repo := pushedRepo(t)
		runGitIn(t, repo, "checkout", "-q", "-b", "unpushed")
		runGitIn(t, repo, "commit", "--allow-empty", "-m", "local only")
		got, err := ResolveBranch(local(repo), BranchRequest{Branch: "unpushed"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != "unpushed" {
			t.Fatalf("Branch = %q", got.Branch)
		}
	})

	t.Run("--new-branch is cut from the current branch", func(t *testing.T) {
		// The base has to be sent explicitly: with no branch in the request the
		// server cuts from its default, which is not the code the caller is
		// looking at.
		repo := pushedRepo(t)
		want := currentBranchOf(t, repo)
		got, err := ResolveBranch(local(repo), BranchRequest{NewBranch: "feature/x"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.NewBranch != "feature/x" {
			t.Fatalf("NewBranch = %q", got.NewBranch)
		}
		if got.Branch != want {
			t.Fatalf("Branch = %q, want the current branch %q as the base", got.Branch, want)
		}
	})

	t.Run("--new-branch from an unpushed branch is refused", func(t *testing.T) {
		// The remote has no such base to cut from, so the server would fall
		// back to its default branch without saying so.
		repo := pushedRepo(t)
		runGitIn(t, repo, "checkout", "-q", "-b", "unpushed")
		runGitIn(t, repo, "commit", "--allow-empty", "-m", "local only")
		_, err := ResolveBranch(local(repo), BranchRequest{NewBranch: "feature/x"})
		if err == nil || !strings.Contains(err.Error(), "has not been pushed") {
			t.Fatalf("err = %v, want an unpushed-base refusal", err)
		}
	})

	t.Run("an explicit --branch base is honored with --new-branch", func(t *testing.T) {
		// Naming the base is intent, so no reachability check applies.
		repo := pushedRepo(t)
		runGitIn(t, repo, "checkout", "-q", "-b", "unpushed")
		runGitIn(t, repo, "commit", "--allow-empty", "-m", "local only")
		got, err := ResolveBranch(local(repo), BranchRequest{Branch: "unpushed", NewBranch: "feature/x"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != "unpushed" || got.NewBranch != "feature/x" {
			t.Fatalf("pair = %+v, want both forwarded", got)
		}
	})

	t.Run("both flags pass through together", func(t *testing.T) {
		repo := pushedRepo(t)
		got, err := ResolveBranch(local(repo), BranchRequest{
			Branch: "release/2.0", NewBranch: "feature/from-release",
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != "release/2.0" || got.NewBranch != "feature/from-release" {
			t.Fatalf("pair = %+v, want both forwarded", got)
		}
	})

	t.Run("a URL source passes through untouched", func(t *testing.T) {
		// There is no local checkout to read a branch from, so the server's
		// default applies unless the caller named one.
		id := Identity{Name: "b", Source: SourceFlagURL, URL: "https://github.com/a/b.git"}
		got, err := ResolveBranch(id, BranchRequest{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != "" || got.NewBranch != "" {
			t.Fatalf("pair = %+v, want empty", got)
		}
		got, err = ResolveBranch(id, BranchRequest{Branch: "develop"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != "develop" {
			t.Fatalf("Branch = %q, want the flag honored", got.Branch)
		}
	})

	t.Run("a detached HEAD leaves the pair empty", func(t *testing.T) {
		repo := pushedRepo(t)
		runGitIn(t, repo, "checkout", "-q", "--detach")
		got, err := ResolveBranch(local(repo), BranchRequest{})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Branch != "" {
			t.Fatalf("Branch = %q, want empty with no branch name to carry", got.Branch)
		}
	})
}
