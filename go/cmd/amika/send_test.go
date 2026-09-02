package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/spf13/cobra"
)

func findChildCommand(root *cobra.Command, name string) *cobra.Command {
	for _, c := range root.Commands() {
		if c.Name() == name {
			return c
		}
	}
	return nil
}

func TestSendAndSessionsCommandsRegistered(t *testing.T) {
	send := findChildCommand(rootCmd, "send")
	if send == nil {
		t.Fatal("send command not registered on rootCmd")
	}
	for _, name := range []string{"agent", "session-id", "sandbox", "new-session", "git", "no-git", "repo", "stream"} {
		if send.Flags().Lookup(name) == nil {
			t.Errorf("send is missing --%s flag", name)
		}
	}

	sessions := findChildCommand(rootCmd, "sessions")
	if sessions == nil {
		t.Fatal("sessions command not registered on rootCmd")
	}
	if findChildCommand(sessions, "list") == nil {
		t.Error("sessions has no list subcommand")
	}
	if findChildCommand(sessions, "show") == nil {
		t.Error("sessions has no show subcommand")
	}
}

func TestSendRequiresMessage(t *testing.T) {
	// Force stdin to an immediate EOF so the no-arg path doesn't read a real
	// terminal / block: with no message from args or stdin, send must error
	// before any auth or network work.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = old
		_ = r.Close()
		resetChangedFlags(rootCmd)
	})

	_, err = runRootCommand("send")
	if err == nil || !strings.Contains(err.Error(), "message is required") {
		t.Fatalf("err = %v, want a message-required error", err)
	}
}

func TestSendRejectsInvalidOutput(t *testing.T) {
	t.Cleanup(func() { resetChangedFlags(rootCmd) })
	_, err := runRootCommand("send", "hi", "--output", "bogus")
	if err == nil || !strings.Contains(err.Error(), "invalid --output") {
		t.Fatalf("err = %v, want an invalid --output error", err)
	}
}

// TestSendRepoIdentity covers which repo a `amika send` message puts in the
// sandbox it creates, and when that question does not apply at all.
func TestSendRepoIdentity(t *testing.T) {
	newSendCmd := func() *cobra.Command {
		cmd := &cobra.Command{Use: "send"}
		gitrepo.AddFlags(cmd, "git usage", "no-git usage")
		gitrepo.AddRepoAlias(cmd)
		return cmd
	}
	fakeRepo := func(t *testing.T, name string) string {
		t.Helper()
		repo := filepath.Join(t.TempDir(), name)
		if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
			t.Fatalf("failed to create fake repo: %v", err)
		}
		return repo
	}
	// chdirTo runs the resolution from inside dir, since auto-detection walks
	// up from the process's working directory.
	chdirTo := func(t *testing.T, dir string) {
		t.Helper()
		old, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chdir(dir); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chdir(old) })
	}

	t.Run("auto-detects the repo containing the cwd", func(t *testing.T) {
		repo := fakeRepo(t, "myrepo")
		chdirTo(t, repo)
		got, err := sendRepoIdentity(newSendCmd(), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != gitrepo.SourceAutoDetect || got.Name != "myrepo" {
			t.Fatalf("identity = %+v, want the auto-detected repo", got)
		}
	})

	t.Run("outside a repo resolves to no repo", func(t *testing.T) {
		chdirTo(t, t.TempDir())
		got, err := sendRepoIdentity(newSendCmd(), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != gitrepo.SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})

	t.Run("--no-git skips auto-detection", func(t *testing.T) {
		repo := fakeRepo(t, "myrepo")
		chdirTo(t, repo)
		cmd := newSendCmd()
		if err := cmd.ParseFlags([]string{"--no-git"}); err != nil {
			t.Fatal(err)
		}
		got, err := sendRepoIdentity(cmd, "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != gitrepo.SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})

	t.Run("--git overrides the cwd repo", func(t *testing.T) {
		chdirTo(t, fakeRepo(t, "cwdrepo"))
		cmd := newSendCmd()
		if err := cmd.ParseFlags([]string{"--git", "https://github.com/foo/bar.git"}); err != nil {
			t.Fatal(err)
		}
		got, err := sendRepoIdentity(cmd, "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != gitrepo.SourceFlagURL || got.URL != "https://github.com/foo/bar.git" {
			t.Fatalf("identity = %+v, want the --git URL", got)
		}
	})

	t.Run("an existing target skips auto-detection", func(t *testing.T) {
		// No sandbox is created for these, so the cwd repo is not a silently
		// dropped part of the request.
		repo := fakeRepo(t, "myrepo")
		chdirTo(t, repo)
		for _, tc := range []struct{ sessionID, sandboxRef string }{
			{sessionID: "sess-1"},
			{sandboxRef: "my-sandbox"},
		} {
			got, err := sendRepoIdentity(newSendCmd(), tc.sessionID, tc.sandboxRef)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Source != gitrepo.SourceNone {
				t.Fatalf("Source = %v for %+v, want none", got.Source, tc)
			}
		}
	})

	t.Run("an existing target rejects an explicit repo", func(t *testing.T) {
		chdirTo(t, t.TempDir())
		for _, flag := range []string{"--git", "--repo"} {
			cmd := newSendCmd()
			if err := cmd.ParseFlags([]string{flag, "https://github.com/foo/bar.git"}); err != nil {
				t.Fatal(err)
			}
			_, err := sendRepoIdentity(cmd, "sess-1", "")
			if err == nil || !strings.Contains(err.Error(), "cannot be combined with --session-id") {
				t.Fatalf("err = %v for %s, want a conflict error", err, flag)
			}
		}
	})

	t.Run("an existing target accepts --no-git", func(t *testing.T) {
		// --no-git asks for exactly what already happens, so it is not a
		// contradiction worth failing on.
		chdirTo(t, fakeRepo(t, "myrepo"))
		cmd := newSendCmd()
		if err := cmd.ParseFlags([]string{"--no-git"}); err != nil {
			t.Fatal(err)
		}
		got, err := sendRepoIdentity(cmd, "sess-1", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Source != gitrepo.SourceNone {
			t.Fatalf("Source = %v, want none", got.Source)
		}
	})
}

// TestUnstreamedRemainder covers what `amika send --stream` still has to print
// after the deltas, given that the streamed text and the authoritative
// `response` come from two different server-side parsers and need not agree.
func TestUnstreamedRemainder(t *testing.T) {
	cases := []struct {
		name         string
		streamed     string
		response     string
		extra        string
		continuation bool
	}{{
		name: "identical adds nothing",
		// The overwhelmingly common case: every byte already reached stdout.
		streamed: "Hello", response: "Hello", extra: "", continuation: false,
	}, {
		name: "nothing streamed prints the whole response",
		// An empty reply, or a provider that only yields a final result.
		streamed: "", response: "Hello", extra: "Hello", continuation: false,
	}, {
		name: "truncated stream appends only the missing tail",
		// A dropped delta must not cost the user the rest of the reply, and
		// the tail resumes the text mid-word rather than on a new line.
		streamed: "Hel", response: "Hello", extra: "lo", continuation: true,
	}, {
		name: "response already contained in a longer stream adds nothing",
		// Intermediate text across tool calls streams more than the final
		// message; appending it again would duplicate the tail.
		streamed: "thinking...\nHello", response: "Hello", extra: "", continuation: false,
	}, {
		name: "divergent response wins",
		// The failed-turn case: `response` carries the agent CLI's own error,
		// which never arrives as a delta.
		streamed: "partial output", response: "Not logged in", extra: "Not logged in", continuation: false,
	}, {
		name:     "empty response adds nothing",
		streamed: "Hello", response: "", extra: "", continuation: false,
	}}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			extra, continuation := unstreamedRemainder(tc.streamed, tc.response)
			if extra != tc.extra || continuation != tc.continuation {
				t.Errorf("unstreamedRemainder(%q, %q) = (%q, %v), want (%q, %v)",
					tc.streamed, tc.response, extra, continuation, tc.extra, tc.continuation)
			}
		})
	}
}
