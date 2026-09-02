package gitrepo

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/cobra"
)

// newTestCmd builds a command carrying the flags a caller opts into: always
// --git/--no-git, plus --no-clean when asked, since only local sandboxes
// offer that one.
func newTestCmd(withNoClean bool) *cobra.Command {
	cmd := &cobra.Command{Use: "test", RunE: func(*cobra.Command, []string) error { return nil }}
	AddFlags(cmd, "git usage", "no-git usage")
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
		cmd := newTestCmd(true)
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
		cmd := newTestCmd(true)
		parseFlags(t, cmd, "--git", flagRepo)
		got, err := FromCommand(cmd, cwdRepo)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceFlagPath || got.Path != flagRepo {
			t.Fatalf("identity = %+v, want --git path %q", got, flagRepo)
		}
	})

	t.Run("--no-git skips auto-detection", func(t *testing.T) {
		repo := makeFakeRepo(t, "myrepo")
		cmd := newTestCmd(true)
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
		withFlag := newTestCmd(true)
		parseFlags(t, withFlag, "--no-clean")
		if _, err := FromCommand(withFlag, t.TempDir()); err == nil {
			t.Fatal("expected --no-clean outside a repo to error")
		}
		// ...and one that does not offer it must resolve as if unset, rather
		// than tripping over a flag it never exposed.
		withoutFlag := newTestCmd(false)
		got, err := FromCommand(withoutFlag, t.TempDir())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})
}
