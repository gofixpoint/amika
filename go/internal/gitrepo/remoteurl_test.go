package gitrepo

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initRepo creates a real git repo with the given remotes, so the origin
// lookup exercises git itself rather than a stub.
func initRepo(t *testing.T, remotes map[string]string) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), "repo")
	runGit(t, filepath.Dir(repo), "init", repo)
	for name, url := range remotes {
		runGit(t, repo, "remote", "add", name, url)
	}
	return repo
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s failed: %s", strings.Join(args, " "), out)
	}
}

func TestResolveURL(t *testing.T) {
	t.Run("a URL passes through", func(t *testing.T) {
		for _, url := range []string{
			"https://github.com/foo/bar.git",
			"http://example.com/foo/bar.git",
			"git@github.com:foo/bar.git",
		} {
			got, err := ResolveURL(url)
			if err != nil {
				t.Fatalf("ResolveURL(%q) failed: %v", url, err)
			}
			if got != url {
				t.Fatalf("ResolveURL(%q) = %q, want it unchanged", url, got)
			}
		}
	})

	t.Run("a local path resolves to its origin remote", func(t *testing.T) {
		repo := initRepo(t, map[string]string{
			"origin":   "https://github.com/example/upstream.git",
			"upstream": "git@github.com:example/other.git",
		})
		got, err := ResolveURL(repo)
		if err != nil {
			t.Fatalf("ResolveURL failed: %v", err)
		}
		if got != "https://github.com/example/upstream.git" {
			t.Fatalf("ResolveURL = %q, want the origin remote", got)
		}
	})

	t.Run("a nested path resolves from the repo root", func(t *testing.T) {
		repo := initRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
		got, err := ResolveURL(filepath.Join(repo, "does", "not", "exist"))
		if err != nil {
			t.Fatalf("ResolveURL failed: %v", err)
		}
		if got != "https://github.com/example/upstream.git" {
			t.Fatalf("ResolveURL = %q, want the origin remote", got)
		}
	})

	t.Run("no origin remote is an error naming --no-git", func(t *testing.T) {
		repo := initRepo(t, map[string]string{"upstream": "https://github.com/example/upstream.git"})
		_, err := ResolveURL(repo)
		if err == nil || !strings.Contains(err.Error(), "no origin remote found") {
			t.Fatalf("err = %v, want a missing-origin error", err)
		}
		if !strings.Contains(err.Error(), "--no-git") {
			t.Fatalf("err = %v, want it to mention --no-git", err)
		}
	})

	t.Run("a local origin is an error", func(t *testing.T) {
		// A path on this machine is unreachable from a remote sandbox, so it
		// must be rejected rather than sent to the API.
		repo := initRepo(t, map[string]string{"origin": "/srv/git/upstream.git"})
		_, err := ResolveURL(repo)
		if err == nil || !strings.Contains(err.Error(), "is a local path") {
			t.Fatalf("err = %v, want a local-origin error", err)
		}
	})

	t.Run("not a repo is an error", func(t *testing.T) {
		_, err := ResolveURL(t.TempDir())
		if err == nil || !strings.Contains(err.Error(), "could not find git repo") {
			t.Fatalf("err = %v, want a missing-repo error", err)
		}
	})
}

func TestIdentityRemoteURL(t *testing.T) {
	t.Run("a URL identity returns its URL verbatim", func(t *testing.T) {
		id := Identity{Name: "bar", Source: SourceFlagURL, URL: "git@github.com:foo/bar.git"}
		got, err := id.RemoteURL()
		if err != nil {
			t.Fatalf("RemoteURL failed: %v", err)
		}
		if got != "git@github.com:foo/bar.git" {
			t.Fatalf("RemoteURL = %q", got)
		}
	})

	t.Run("a local identity resolves its origin", func(t *testing.T) {
		repo := initRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
		for _, source := range []Source{SourceAutoDetect, SourceFlagPath} {
			id := Identity{Name: "repo", Source: source, Path: repo}
			got, err := id.RemoteURL()
			if err != nil {
				t.Fatalf("RemoteURL failed: %v", err)
			}
			if got != "https://github.com/example/upstream.git" {
				t.Fatalf("RemoteURL = %q, want the origin remote", got)
			}
		}
	})

	t.Run("no repo returns an empty URL and no error", func(t *testing.T) {
		got, err := Identity{Source: SourceNone}.RemoteURL()
		if err != nil {
			t.Fatalf("RemoteURL failed: %v", err)
		}
		if got != "" {
			t.Fatalf("RemoteURL = %q, want empty", got)
		}
	})
}

func TestIdentityIsLocalPath(t *testing.T) {
	tests := []struct {
		source Source
		want   bool
	}{
		{source: SourceAutoDetect, want: true},
		{source: SourceFlagPath, want: true},
		{source: SourceFlagURL, want: false},
		{source: SourceNone, want: false},
	}
	for _, tt := range tests {
		if got := (Identity{Source: tt.source}).IsLocalPath(); got != tt.want {
			t.Fatalf("IsLocalPath() for source %v = %v, want %v", tt.source, got, tt.want)
		}
	}
}

func TestDefaultBranch(t *testing.T) {
	t.Run("reads the recorded origin HEAD", func(t *testing.T) {
		repo := initRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
		runGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
		got, err := DefaultBranch(repo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "develop" {
			t.Fatalf("DefaultBranch = %q, want %q", got, "develop")
		}
	})

	t.Run("a branch name containing slashes survives", func(t *testing.T) {
		repo := initRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
		runGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release/v2")
		got, err := DefaultBranch(repo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "release/v2" {
			t.Fatalf("DefaultBranch = %q, want %q", got, "release/v2")
		}
	})

	t.Run("no recorded HEAD is an error, not a guess", func(t *testing.T) {
		// `git init` plus a manually added remote records no origin HEAD.
		// Returning "main" here would put a wrong branch in a warning.
		repo := initRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
		if _, err := DefaultBranch(repo); err == nil {
			t.Fatal("expected an error when origin HEAD is unrecorded")
		}
	})

	t.Run("not a repo is an error", func(t *testing.T) {
		if _, err := DefaultBranch(t.TempDir()); err == nil {
			t.Fatal("expected an error outside a repo")
		}
	})
}
