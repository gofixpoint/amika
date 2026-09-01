package main

import (
	"os"
	"strings"
	"testing"

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
	for _, name := range []string{"agent", "session-id", "sandbox", "new-session", "repo", "stream", "model", "effort"} {
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

// Cobra reads a backquoted span in a usage string as the flag's value
// placeholder, so a backquoted example in the description made --model
// advertise its argument type as that example instead of "string".
// Asserting the type keeps that from creeping back.
func TestSendTuningFlagsAdvertiseStringValues(t *testing.T) {
	send := findChildCommand(rootCmd, "send")
	if send == nil {
		t.Fatal("send command not registered on rootCmd")
	}
	for _, name := range []string{"model", "effort"} {
		flag := send.Flags().Lookup(name)
		if flag == nil {
			t.Fatalf("send is missing --%s flag", name)
		}
		if flag.Value.Type() != "string" {
			t.Errorf("--%s value type = %q, want string", name, flag.Value.Type())
		}
		if strings.Contains(flag.Usage, "`") {
			t.Errorf("--%s usage contains a backquote, which cobra reads as the value placeholder: %q", name, flag.Usage)
		}
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
