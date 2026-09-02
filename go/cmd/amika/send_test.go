package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/internal/output"
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
	for _, name := range []string{"agent", "session-id", "sandbox", "new-session", "git", "repo", "no-git", "stream"} {
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

// TestSendRepo covers which repo the sandbox created for a message clones,
// and when the working directory is not consulted at all.
func TestSendRepo(t *testing.T) {
	// initRepo builds a real repo, since resolving a repo to its "origin"
	// shells out to git.
	initRepo := func(t *testing.T, name string, remotes map[string]string) string {
		t.Helper()
		repo := filepath.Join(t.TempDir(), name)
		run := func(dir string, args ...string) {
			t.Helper()
			cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("git %v failed: %s", args, out)
			}
		}
		run(filepath.Dir(repo), "init", repo)
		for n, url := range remotes {
			run(repo, "remote", "add", n, url)
		}
		return repo
	}
	// chdir runs the resolution from inside dir, since auto-detection walks up
	// from the process's working directory.
	chdir := func(t *testing.T, dir string) {
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
	const origin = "https://github.com/example/upstream.git"
	// sendRepo reads the repo flags off the command, so tests need one
	// registering the same set `send` does.
	newCmd := func(t *testing.T, args ...string) *cobra.Command {
		t.Helper()
		cmd := &cobra.Command{Use: "send"}
		gitrepo.AddFlags(cmd, "git", "no-git")
		gitrepo.AddRepoAlias(cmd)
		if err := cmd.ParseFlags(args); err != nil {
			t.Fatal(err)
		}
		return cmd
	}

	t.Run("infers the origin of the repo containing the cwd", func(t *testing.T) {
		chdir(t, initRepo(t, "myrepo", map[string]string{"origin": origin}))
		url, name, err := sendRepo(newCmd(t), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != origin {
			t.Fatalf("url = %q, want %q", url, origin)
		}
		if name != "myrepo" {
			t.Fatalf("name = %q, want %q", name, "myrepo")
		}
	})

	t.Run("infers from a nested directory", func(t *testing.T) {
		repo := initRepo(t, "myrepo", map[string]string{"origin": origin})
		nested := filepath.Join(repo, "a", "b")
		if err := os.MkdirAll(nested, 0o755); err != nil {
			t.Fatal(err)
		}
		chdir(t, nested)
		url, _, err := sendRepo(newCmd(t), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != origin {
			t.Fatalf("url = %q, want %q", url, origin)
		}
	})

	t.Run("outside a repo sends no repo", func(t *testing.T) {
		chdir(t, t.TempDir())
		url, name, err := sendRepo(newCmd(t), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "" || name != "" {
			t.Fatalf("url = %q, name = %q, want both empty", url, name)
		}
	})

	t.Run("--no-git skips detection inside a repo", func(t *testing.T) {
		chdir(t, initRepo(t, "myrepo", map[string]string{"origin": origin}))
		url, name, err := sendRepo(newCmd(t, "--no-git"), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "" || name != "" {
			t.Fatalf("url = %q, name = %q, want both empty", url, name)
		}
	})

	t.Run("--repo overrides the detected repo", func(t *testing.T) {
		chdir(t, initRepo(t, "myrepo", map[string]string{"origin": origin}))
		url, _, err := sendRepo(newCmd(t, "--repo", "https://github.com/other/thing.git"), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "https://github.com/other/thing.git" {
			t.Fatalf("url = %q, want the --repo value", url)
		}
	})

	t.Run("--git overrides the detected repo", func(t *testing.T) {
		chdir(t, initRepo(t, "myrepo", map[string]string{"origin": origin}))
		url, name, err := sendRepo(newCmd(t, "--git", "https://github.com/other/thing.git"), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "https://github.com/other/thing.git" || name != "thing" {
			t.Fatalf("url = %q, name = %q, want the --git repo", url, name)
		}
	})

	t.Run("--repo resolves a local path, like --git", func(t *testing.T) {
		// The alias is the same input under an older name, so it gained path
		// support rather than staying URL-only.
		other := initRepo(t, "otherrepo", map[string]string{"origin": "https://github.com/example/other.git"})
		chdir(t, initRepo(t, "myrepo", map[string]string{"origin": origin}))
		url, name, err := sendRepo(newCmd(t, "--repo", other), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "https://github.com/example/other.git" || name != "otherrepo" {
			t.Fatalf("url = %q, name = %q, want the --repo path's origin", url, name)
		}
	})

	t.Run("--git and --repo agreeing is accepted", func(t *testing.T) {
		chdir(t, t.TempDir())
		url, _, err := sendRepo(newCmd(t,
			"--git", "https://github.com/a/b.git",
			"--repo", "https://github.com/a/b.git"), "", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "https://github.com/a/b.git" {
			t.Fatalf("url = %q", url)
		}
	})

	t.Run("an existing target accepts --no-git", func(t *testing.T) {
		// --no-git asks for what already happens there, so it is no conflict.
		chdir(t, initRepo(t, "myrepo", map[string]string{"origin": origin}))
		url, name, err := sendRepo(newCmd(t, "--no-git"), "sess-1", "")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if url != "" || name != "" {
			t.Fatalf("url = %q, name = %q, want both empty", url, name)
		}
	})

	t.Run("a repo with no origin is an error naming the way out", func(t *testing.T) {
		chdir(t, initRepo(t, "myrepo", nil))
		_, _, err := sendRepo(newCmd(t), "", "")
		if err == nil || !strings.Contains(err.Error(), "no origin remote found") {
			t.Fatalf("err = %v, want a missing-origin error", err)
		}
		if !strings.Contains(err.Error(), "--no-git") {
			t.Fatalf("err = %v, want it to mention --no-git", err)
		}
	})

	t.Run("an existing target never consults the cwd", func(t *testing.T) {
		// Not merely "sends no repo": a repo with no origin would error if the
		// working directory were consulted at all, so this also pins that the
		// detection is skipped rather than attempted and discarded.
		chdir(t, initRepo(t, "myrepo", nil))
		for _, tc := range []struct{ sessionID, sandboxRef string }{
			{sessionID: "sess-1"},
			{sandboxRef: "my-sandbox"},
		} {
			url, name, err := sendRepo(newCmd(t), tc.sessionID, tc.sandboxRef)
			if err != nil {
				t.Fatalf("unexpected error for %+v: %v", tc, err)
			}
			if url != "" || name != "" {
				t.Fatalf("url = %q, name = %q for %+v, want both empty", url, name, tc)
			}
		}
	})
}

// TestValidateSendRepoFlags covers the checks that run before the auth gate,
// so a mistyped invocation is reported without needing credentials.
func TestValidateSendRepoFlags(t *testing.T) {
	newCmd := func(t *testing.T, args ...string) *cobra.Command {
		t.Helper()
		cmd := &cobra.Command{Use: "send"}
		gitrepo.AddFlags(cmd, "git", "no-git")
		gitrepo.AddRepoAlias(cmd)
		if err := cmd.ParseFlags(args); err != nil {
			t.Fatal(err)
		}
		return cmd
	}

	t.Run("a repo flag with --no-git is refused, naming the flag typed", func(t *testing.T) {
		for _, flag := range []string{"--git", "--repo"} {
			err := validateSendRepoFlags(newCmd(t, flag, "https://github.com/a/b.git", "--no-git"), "", "")
			if err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
				t.Fatalf("err = %v for %s, want a mutual-exclusion error", err, flag)
			}
			if !strings.Contains(err.Error(), flag) {
				t.Fatalf("err = %v, want it to name %s", err, flag)
			}
		}
	})

	t.Run("--git and --repo disagreeing is ambiguous", func(t *testing.T) {
		err := validateSendRepoFlags(newCmd(t,
			"--git", "https://github.com/a/b.git",
			"--repo", "https://github.com/c/d.git"), "", "")
		if err == nil || !strings.Contains(err.Error(), "same flag under two names") {
			t.Fatalf("err = %v, want an ambiguity error", err)
		}
	})

	t.Run("--git with an empty value is refused", func(t *testing.T) {
		err := validateSendRepoFlags(newCmd(t, "--git", "  "), "", "")
		if err == nil || !strings.Contains(err.Error(), "requires a non-empty value") {
			t.Fatalf("err = %v, want an empty-value error", err)
		}
	})

	t.Run("an existing target refuses an explicit repo rather than dropping it", func(t *testing.T) {
		// Before inference existed, --repo with --sandbox reached the API as-is.
		// Silently discarding it would be a regression visible only in what the
		// agent could see, so it is an error.
		for _, flag := range []string{"--git", "--repo"} {
			for _, tc := range []struct{ sessionID, sandboxRef string }{
				{sessionID: "sess-1"},
				{sandboxRef: "my-sandbox"},
			} {
				err := validateSendRepoFlags(newCmd(t, flag, "https://github.com/a/b.git"), tc.sessionID, tc.sandboxRef)
				if err == nil || !strings.Contains(err.Error(), "cannot be combined with --session-id or --sandbox") {
					t.Fatalf("err = %v for %s %+v, want a refusal", err, flag, tc)
				}
				if !strings.Contains(err.Error(), flag) {
					t.Fatalf("err = %v, want it to name %s", err, flag)
				}
			}
		}
	})

	t.Run("an existing target with no repo flag, or --no-git, is fine", func(t *testing.T) {
		for _, args := range [][]string{nil, {"--no-git"}} {
			if err := validateSendRepoFlags(newCmd(t, args...), "sess-1", ""); err != nil {
				t.Fatalf("unexpected error for %v: %v", args, err)
			}
		}
	})

	t.Run("a plain invocation passes", func(t *testing.T) {
		if err := validateSendRepoFlags(newCmd(t), "", ""); err != nil {
			t.Fatalf("unexpected error: %v", err)
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

// TestPrintSendRepo pins the output contract for the repo line: stderr in text
// mode, nothing at all in JSON mode. Getting this wrong by writing to stdout
// would put a bare "repo: x" ahead of the JSON object and break every scripted
// consumer, so it is worth a test of its own.
func TestPrintSendRepo(t *testing.T) {
	tests := []struct {
		name   string
		format string
		repo   string
		want   string
	}{
		{name: "text mode names the repo", format: "text", repo: "myrepo", want: "repo: myrepo\n"},
		{name: "text mode with no repo says nothing", format: "text", repo: "", want: ""},
		{name: "json mode is silent", format: "json", repo: "myrepo", want: ""},
		{name: "json-pretty mode is silent", format: "json-pretty", repo: "myrepo", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			format, err := output.ParseFormat(tt.format)
			if err != nil {
				t.Fatalf("ParseFormat(%q): %v", tt.format, err)
			}
			var buf strings.Builder
			printSendRepo(format, &buf, tt.repo)
			if got := buf.String(); got != tt.want {
				t.Fatalf("output = %q, want %q", got, tt.want)
			}
		})
	}
}
