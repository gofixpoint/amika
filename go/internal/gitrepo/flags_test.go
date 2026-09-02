package gitrepo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// newTestCmd builds a command carrying the flags a caller opts into: always
// --git/--no-git, plus --repo and --no-clean when asked, mirroring how
// `amika send` and `amika sandbox create` differ.
func newTestCmd(withRepoAlias, withNoClean bool) *cobra.Command {
	cmd := &cobra.Command{Use: "test", RunE: func(*cobra.Command, []string) error { return nil }}
	AddFlags(cmd, "git usage", "no-git usage")
	if withRepoAlias {
		AddRepoAlias(cmd)
	}
	if withNoClean {
		cmd.Flags().Bool(FlagNoClean, false, "no-clean usage")
	}
	return cmd
}

func parseFlags(t *testing.T, cmd *cobra.Command, args ...string) {
	t.Helper()
	if err := cmd.ParseFlags(args); err != nil {
		t.Fatalf("ParseFlags(%v) failed: %v", args, err)
	}
}

func makeFakeRepo(t *testing.T, name string) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatalf("failed to create fake repo: %v", err)
	}
	return repo
}

func TestFromCommand(t *testing.T) {
	t.Run("no flags auto-detects from cwd", func(t *testing.T) {
		repo := makeFakeRepo(t, "myrepo")
		cmd := newTestCmd(true, true)
		got, err := FromCommand(cmd, repo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceAutoDetect || got.Path != repo {
			t.Fatalf("identity = %+v, want auto-detected %q", got, repo)
		}
	})

	t.Run("--git wins over auto-detection", func(t *testing.T) {
		cwdRepo := makeFakeRepo(t, "cwdrepo")
		flagRepo := makeFakeRepo(t, "flagrepo")
		cmd := newTestCmd(true, true)
		parseFlags(t, cmd, "--git", flagRepo)
		got, err := FromCommand(cmd, cwdRepo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagPath || got.Path != flagRepo {
			t.Fatalf("identity = %+v, want --git path %q", got, flagRepo)
		}
	})

	t.Run("--repo is an alias for --git", func(t *testing.T) {
		cwdRepo := makeFakeRepo(t, "cwdrepo")
		cmd := newTestCmd(true, false)
		parseFlags(t, cmd, "--repo", "https://github.com/foo/bar.git")
		got, err := FromCommand(cmd, cwdRepo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagURL || got.URL != "https://github.com/foo/bar.git" {
			t.Fatalf("identity = %+v, want the --repo URL", got)
		}
	})

	t.Run("--repo forwards a user-less scp URL as a URL", func(t *testing.T) {
		// `send --repo` used to reach the API without any classification, so
		// this form has to stay a URL rather than be read as a local path.
		cmd := newTestCmd(true, false)
		parseFlags(t, cmd, "--repo", "build-host:org/repo.git")
		got, err := FromCommand(cmd, t.TempDir())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagURL || got.URL != "build-host:org/repo.git" {
			t.Fatalf("identity = %+v, want the scp-style URL", got)
		}
	})

	t.Run("--git and --repo disagreeing is an error", func(t *testing.T) {
		cmd := newTestCmd(true, false)
		parseFlags(t, cmd, "--git", "https://github.com/foo/bar.git", "--repo", "https://github.com/foo/other.git")
		_, err := FromCommand(cmd, t.TempDir())
		if err == nil || !strings.Contains(err.Error(), "alias") {
			t.Fatalf("err = %v, want an alias conflict error", err)
		}
	})

	t.Run("--git and --repo agreeing is accepted", func(t *testing.T) {
		cmd := newTestCmd(true, false)
		parseFlags(t, cmd, "--git", "https://github.com/foo/bar.git", "--repo", "https://github.com/foo/bar.git")
		got, err := FromCommand(cmd, t.TempDir())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Name != "bar" {
			t.Fatalf("Name = %q, want %q", got.Name, "bar")
		}
	})

	t.Run("--no-git skips auto-detection", func(t *testing.T) {
		repo := makeFakeRepo(t, "myrepo")
		cmd := newTestCmd(true, true)
		parseFlags(t, cmd, "--no-git")
		got, err := FromCommand(cmd, repo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})

	t.Run("--no-clean is read only where it is registered", func(t *testing.T) {
		// The command that offers --no-clean must see it enforced...
		withFlag := newTestCmd(false, true)
		parseFlags(t, withFlag, "--no-clean")
		if _, err := FromCommand(withFlag, t.TempDir()); err == nil {
			t.Fatal("expected --no-clean outside a repo to error")
		}
		// ...and one that does not offer it must resolve as if unset, rather
		// than tripping over a flag it never exposed.
		withoutFlag := newTestCmd(true, false)
		got, err := FromCommand(withoutFlag, t.TempDir())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})
}

func TestFlagsChanged(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "nothing set", args: nil, want: false},
		{name: "--git set", args: []string{"--git", "https://github.com/foo/bar.git"}, want: true},
		{name: "--repo set", args: []string{"--repo", "https://github.com/foo/bar.git"}, want: true},
		// --no-git asks for the default outcome, so it is not a repo request.
		{name: "--no-git set", args: []string{"--no-git"}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := newTestCmd(true, false)
			parseFlags(t, cmd, tt.args...)
			if got := FlagsChanged(cmd); got != tt.want {
				t.Fatalf("FlagsChanged() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFlagsChangedWithoutRepoAlias(t *testing.T) {
	// A command that never registered --repo must not panic looking for it.
	cmd := newTestCmd(false, true)
	if FlagsChanged(cmd) {
		t.Fatal("FlagsChanged() = true with no flags set")
	}
}
