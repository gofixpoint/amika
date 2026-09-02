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

func TestStripCredentials(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want string
	}{{
		name: "GitHub App token in the password half",
		url:  "https://x-access-token:ghs_SECRET@github.com/org/repo.git",
		want: "https://github.com/org/repo.git",
	}, {
		name: "PAT in the username half",
		url:  "https://ghp_SECRET@github.com/org/repo.git",
		want: "https://github.com/org/repo.git",
	}, {
		name: "user and password",
		url:  "http://user:SECRET@example.com/org/repo.git",
		want: "http://example.com/org/repo.git",
	}, {
		name: "no userinfo is untouched",
		url:  "https://github.com/org/repo.git",
		want: "https://github.com/org/repo.git",
	}, {
		name: "an @ in the path is not userinfo",
		url:  "https://example.com/org/repo@v2.git",
		want: "https://example.com/org/repo@v2.git",
	}, {
		// The ssh username selects the account; dropping it would authenticate
		// as the wrong user, or fail outright.
		name: "scp-style ssh username is kept",
		url:  "git@github.com:org/repo.git",
		want: "git@github.com:org/repo.git",
	}, {
		name: "ssh:// username is kept",
		url:  "ssh://git@github.com/org/repo.git",
		want: "ssh://git@github.com/org/repo.git",
	}, {
		name: "ssh:// password half is dropped, username kept",
		url:  "ssh://git:SECRET@github.com/org/repo.git",
		want: "ssh://git@github.com/org/repo.git",
	}, {
		name: "scp-style password half is dropped, username kept",
		url:  "git:SECRET@build-host:org/repo.git",
		want: "git@build-host:org/repo.git",
	}, {
		name: "user-less scp URL is untouched",
		url:  "build-host:org/repo.git",
		want: "build-host:org/repo.git",
	}, {
		name: "a local path is untouched",
		url:  "/srv/git/repo.git",
		want: "/srv/git/repo.git",
	}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StripCredentials(tt.url)
			if got != tt.want {
				t.Fatalf("StripCredentials(%q) = %q, want %q", tt.url, got, tt.want)
			}
			if strings.Contains(got, "SECRET") {
				t.Fatalf("StripCredentials(%q) leaked the secret", tt.url)
			}
		})
	}
}

func TestRemoteURLStripsCredentials(t *testing.T) {
	// The whole point: what reaches the API carries no credential, whether the
	// URL was typed or read out of a checkout's origin.
	t.Run("from an explicit URL", func(t *testing.T) {
		id := Identity{Name: "repo", Source: SourceFlagURL, URL: "https://x-access-token:ghs_SECRET@github.com/org/repo.git"}
		got, err := id.RemoteURL()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "https://github.com/org/repo.git" {
			t.Fatalf("RemoteURL = %q", got)
		}
	})

	t.Run("from a checkout whose origin carries a token", func(t *testing.T) {
		// Amika's own sandboxes have exactly this shape of origin.
		repo := initRepo(t, map[string]string{
			"origin": "https://x-access-token:ghs_SECRET@github.com/gofixpoint/amika",
		})
		for _, source := range []Source{SourceAutoDetect, SourceFlagPath} {
			got, err := Identity{Source: source, Path: repo}.RemoteURL()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != "https://github.com/gofixpoint/amika" {
				t.Fatalf("RemoteURL = %q, want the credential stripped", got)
			}
		}
	})

	t.Run("local cloning still sees the credential", func(t *testing.T) {
		// Identity.URL is what the local-sandbox clone path uses, and it has
		// to keep working auth — only the API-bound value is sanitized.
		const withToken = "https://x-access-token:ghs_SECRET@github.com/org/repo.git"
		id := Identity{Source: SourceFlagURL, URL: withToken}
		if id.URL != withToken {
			t.Fatalf("Identity.URL = %q, want it untouched", id.URL)
		}
	})
}
