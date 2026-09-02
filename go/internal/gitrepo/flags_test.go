package gitrepo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// newTestCmd builds a command carrying the flags a caller opts into: always
// --git/--no-git, plus the --repo alias and --no-clean when asked. That mirrors
// the real split — `amika send` registers the alias, `amika sandbox create`
// registers --no-clean, and neither registers the other's.
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
		cmd := newTestCmd(false, true)
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
		cmd := newTestCmd(false, true)
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
		cmd := newTestCmd(false, true)
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
		withoutFlag := newTestCmd(false, false)
		got, err := FromCommand(withoutFlag, t.TempDir())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})
}

func TestFromCommandWithoutGitFlag(t *testing.T) {
	// `amika send` registers --no-git without --git, so the reader has to treat
	// the missing flag as unset rather than depending on pflag's forgiving
	// lookups.
	cmd := &cobra.Command{Use: "sendlike"}
	cmd.Flags().Bool(FlagNoGit, false, "no-git usage")

	repo := makeFakeRepo(t, "myrepo")
	got, err := FromCommand(cmd, repo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Source != SourceAutoDetect || got.Name != "myrepo" {
		t.Fatalf("identity = %+v, want the auto-detected repo", got)
	}

	parseFlags(t, cmd, "--no-git")
	got, err = FromCommand(cmd, repo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Source != SourceNone {
		t.Fatalf("Source = %v, want none", got.Source)
	}
}

func TestOptionsValidate(t *testing.T) {
	tests := []struct {
		name string
		opts Options
		want string // substring, or "" for no error
	}{{
		name: "nothing set",
		opts: Options{},
	}, {
		name: "git alone",
		opts: Options{Git: "https://github.com/a/b.git", GitSet: true},
	}, {
		// GitFlagName defaults to --git, which is what keeps `sandbox create`'s
		// messages stable: it never sets the field, and must never be told
		// about an alias it does not register.
		name: "git with no-git names --git when GitFlagName is unset",
		opts: Options{Git: "x", GitSet: true, NoGit: true},
		want: "--git and --no-git are mutually exclusive",
	}, {
		name: "git with no-git names the alias when GitFlagName says so",
		opts: Options{Git: "x", GitSet: true, NoGit: true, GitFlagName: FlagRepo},
		want: "--repo and --no-git are mutually exclusive",
	}, {
		name: "empty value names --git",
		opts: Options{Git: "   ", GitSet: true},
		want: "--git requires a non-empty value",
	}, {
		name: "empty value names the alias",
		opts: Options{Git: "", GitSet: true, GitFlagName: FlagRepo},
		want: "--repo requires a non-empty value",
	}, {
		name: "no-clean with no-git",
		opts: Options{NoClean: true, NoGit: true},
		want: "--no-clean and --no-git are mutually exclusive",
	}, {
		name: "no-clean with a URL",
		opts: Options{Git: "https://github.com/a/b.git", GitSet: true, NoClean: true},
		want: "--no-clean cannot be used with a git URL",
	}, {
		// A path is fine with --no-clean; only a URL is not.
		name: "no-clean with a path",
		opts: Options{Git: "/some/path", GitSet: true, NoClean: true},
	}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.opts.Validate()
			if tt.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.want)
			}
		})
	}
}

func TestValidateFlags(t *testing.T) {
	t.Run("a command without the alias reports --git", func(t *testing.T) {
		// This is `sandbox create`'s shape. Its error wording is pinned here
		// so a change to how readFlags picks GitFlagName cannot make create
		// advise a flag it does not accept.
		cmd := newTestCmd(false, true)
		parseFlags(t, cmd, "--git", "x", "--no-git")
		err := ValidateFlags(cmd)
		if err == nil || !strings.Contains(err.Error(), "--git and --no-git") {
			t.Fatalf("err = %v, want it to name --git", err)
		}
		if strings.Contains(err.Error(), "--"+FlagRepo) {
			t.Fatalf("err = %v, must not mention a flag this command lacks", err)
		}
	})

	t.Run("the alias alone reports --repo", func(t *testing.T) {
		cmd := newTestCmd(true, false)
		parseFlags(t, cmd, "--repo", "x", "--no-git")
		err := ValidateFlags(cmd)
		if err == nil || !strings.Contains(err.Error(), "--repo and --no-git") {
			t.Fatalf("err = %v, want it to name --repo", err)
		}
	})

	t.Run("both spellings agreeing reports --git, matching RequestedFlag", func(t *testing.T) {
		cmd := newTestCmd(true, false)
		parseFlags(t, cmd, "--git", "x", "--repo", "x", "--no-git")
		err := ValidateFlags(cmd)
		if err == nil || !strings.Contains(err.Error(), "--git and --no-git") {
			t.Fatalf("err = %v, want it to name --git", err)
		}
		if got := RequestedFlag(cmd); got != FlagGit {
			t.Fatalf("RequestedFlag() = %q, want %q — the two must agree", got, FlagGit)
		}
	})

	t.Run("a valid invocation passes without touching the filesystem", func(t *testing.T) {
		// A path that does not exist must still validate: ValidateFlags is the
		// pure half, and resolution is what rejects a bad path.
		cmd := newTestCmd(true, true)
		parseFlags(t, cmd, "--git", "/no/such/path/anywhere")
		if err := ValidateFlags(cmd); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestRequestedFlag(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "nothing set", args: nil, want: ""},
		{name: "--git", args: []string{"--git", "x"}, want: FlagGit},
		{name: "--repo", args: []string{"--repo", "x"}, want: FlagRepo},
		{name: "both prefers --git", args: []string{"--git", "x", "--repo", "x"}, want: FlagGit},
		// --no-git asks for the default outcome, so it is not a repo request.
		{name: "--no-git", args: []string{"--no-git"}, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := newTestCmd(true, false)
			parseFlags(t, cmd, tt.args...)
			if got := RequestedFlag(cmd); got != tt.want {
				t.Fatalf("RequestedFlag() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRequestedFlagWithoutAlias(t *testing.T) {
	// A command that never registered --repo must not panic looking for it.
	cmd := newTestCmd(false, true)
	if got := RequestedFlag(cmd); got != "" {
		t.Fatalf("RequestedFlag() = %q, want empty", got)
	}
}

func TestResolveRejectsANonexistentExplicitPath(t *testing.T) {
	// ResolveRoot walks up, so without a guard an explicit value that does not
	// exist — a typo, or GitHub shorthand like "acme/billing" — would resolve
	// to whatever repo encloses the caller.
	repo := makeFakeRepo(t, "enclosing")
	nested := filepath.Join(repo, "sub")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"acme/billing", "totally/bogus/path", "no-such-dir"} {
		_, err := Resolve(Options{Cwd: nested, Git: v, GitSet: true})
		if err == nil {
			t.Fatalf("Resolve(%q) succeeded, want an error rather than the enclosing repo", v)
		}
		if !strings.Contains(err.Error(), "could not find git repo") {
			t.Fatalf("Resolve(%q) err = %v, want a missing-repo error", v, err)
		}
	}
	// A path that does exist still resolves by walking up to the repo root.
	got, err := Resolve(Options{Cwd: "/", Git: nested, GitSet: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Source != SourceFlagPath || got.Path != repo {
		t.Fatalf("identity = %+v, want the repo containing %q", got, nested)
	}
}
