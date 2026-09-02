package gitrepo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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

		got, err := ResolveRoot(nested)
		if err != nil {
			t.Fatalf("ResolveRoot failed: %v", err)
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

		got, err := ResolveRoot(nested)
		if err != nil {
			t.Fatalf("ResolveRoot failed: %v", err)
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

		got, err := ResolveRoot(filePath)
		if err != nil {
			t.Fatalf("ResolveRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("errors when repo is not found", func(t *testing.T) {
		dir := t.TempDir()
		_, err := ResolveRoot(dir)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "no git repository root found") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestIsNetworkURL(t *testing.T) {
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
		if got := IsNetworkURL(tt.url); got != tt.want {
			t.Fatalf("IsNetworkURL(%q) = %v, want %v", tt.url, got, tt.want)
		}
	}
}

func TestResolve(t *testing.T) {
	makeRepo := func(t *testing.T, name string) string {
		t.Helper()
		root := t.TempDir()
		repo := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
			t.Fatalf("failed to create fake repo: %v", err)
		}
		return repo
	}

	t.Run("auto-detect from in-repo cwd", func(t *testing.T) {
		repo := makeRepo(t, "myrepo")
		nested := filepath.Join(repo, "sub", "dir")
		if err := os.MkdirAll(nested, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		got, err := Resolve(Options{Cwd: nested})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceAutoDetect {
			t.Fatalf("Source = %v, want autoDetect", got.Source)
		}
		if got.Name != "myrepo" {
			t.Fatalf("Name = %q, want %q", got.Name, "myrepo")
		}
		if got.Path != repo {
			t.Fatalf("Path = %q, want %q", got.Path, repo)
		}
	})

	t.Run("auto-detect outside repo returns none", func(t *testing.T) {
		dir := t.TempDir()
		got, err := Resolve(Options{Cwd: dir})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})

	t.Run("auto-detect + --no-clean uses repo", func(t *testing.T) {
		repo := makeRepo(t, "myrepo")
		got, err := Resolve(Options{Cwd: repo, NoClean: true})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceAutoDetect {
			t.Fatalf("Source = %v, want autoDetect", got.Source)
		}
		if got.Path != repo {
			t.Fatalf("Path = %q, want %q", got.Path, repo)
		}
	})

	t.Run("--no-git in repo returns none", func(t *testing.T) {
		repo := makeRepo(t, "myrepo")
		got, err := Resolve(Options{Cwd: repo, NoGit: true})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})

	t.Run("--git <path>", func(t *testing.T) {
		repo := makeRepo(t, "fromflag")
		got, err := Resolve(Options{Cwd: "/tmp", Git: repo, GitSet: true})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagPath {
			t.Fatalf("Source = %v, want flagPath", got.Source)
		}
		if got.Name != "fromflag" {
			t.Fatalf("Name = %q, want %q", got.Name, "fromflag")
		}
	})

	t.Run("--git <https url>", func(t *testing.T) {
		got, err := Resolve(Options{Cwd: "/tmp", Git: "https://github.com/foo/bar.git", GitSet: true})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagURL {
			t.Fatalf("Source = %v, want flagURL", got.Source)
		}
		if got.Name != "bar" {
			t.Fatalf("Name = %q, want %q", got.Name, "bar")
		}
		if got.URL != "https://github.com/foo/bar.git" {
			t.Fatalf("URL = %q", got.URL)
		}
	})

	t.Run("--git <ssh url>", func(t *testing.T) {
		got, err := Resolve(Options{Cwd: "/tmp", Git: "git@github.com:foo/baz.git", GitSet: true})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagURL {
			t.Fatalf("Source = %v, want flagURL", got.Source)
		}
		if got.Name != "baz" {
			t.Fatalf("Name = %q, want %q", got.Name, "baz")
		}
	})

	t.Run("--git + --no-git is an error", func(t *testing.T) {
		if _, err := Resolve(Options{Cwd: "/tmp", Git: "https://x/y.git", GitSet: true, NoGit: true}); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("--no-clean + --no-git is an error", func(t *testing.T) {
		if _, err := Resolve(Options{Cwd: "/tmp", NoGit: true, NoClean: true}); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("--no-clean + --git <url> is an error", func(t *testing.T) {
		if _, err := Resolve(Options{Cwd: "/tmp", Git: "https://x/y.git", GitSet: true, NoClean: true}); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("--no-clean without a repo is an error", func(t *testing.T) {
		dir := t.TempDir()
		if _, err := Resolve(Options{Cwd: dir, NoClean: true}); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("--git with empty value is an error", func(t *testing.T) {
		if _, err := Resolve(Options{Cwd: "/tmp", Git: "  ", GitSet: true}); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("--git <bad path> is an error", func(t *testing.T) {
		bogus := filepath.Join(t.TempDir(), "no-such-dir")
		if _, err := Resolve(Options{Cwd: "/tmp", Git: bogus, GitSet: true}); err == nil {
			t.Fatal("expected error")
		}
	})
}

func TestNameFromURL(t *testing.T) {
	tests := []struct {
		url     string
		want    string
		wantErr bool
	}{
		{url: "https://github.com/foo/bar", want: "bar"},
		{url: "https://github.com/foo/bar.git", want: "bar"},
		{url: "https://github.com/foo/bar/", want: "bar"},
		{url: "http://example.com/foo/bar.git", want: "bar"},
		{url: "git@github.com:foo/bar.git", want: "bar"},
		{url: "git@github.com:foo/bar", want: "bar"},
		{url: "ssh://git@github.com/foo/bar.git", want: "bar"},
		{url: "ssh://git@github.com:22/foo/bar.git", want: "bar"},
		{url: "https://gitlab.com/group/subgroup/repo.git", want: "repo"},
		{url: "  https://github.com/foo/bar.git  ", want: "bar"},
		{url: "", wantErr: true},
		{url: "   ", wantErr: true},
		{url: "https://github.com/", wantErr: true},
		{url: "https://github.com", wantErr: true},
		{url: "just-a-name", wantErr: true},
		{url: "https://example.com/foo/.", wantErr: true},
		{url: "https://example.com/foo/..", wantErr: true},
		{url: "https://example.com/foo/..git", wantErr: true},
		{url: "git@example.com:foo/.", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			got, err := NameFromURL(tt.url)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("NameFromURL(%q) = %q, want error", tt.url, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("NameFromURL(%q) unexpected error: %v", tt.url, err)
			}
			if got != tt.want {
				t.Fatalf("NameFromURL(%q) = %q, want %q", tt.url, got, tt.want)
			}
		})
	}
}
