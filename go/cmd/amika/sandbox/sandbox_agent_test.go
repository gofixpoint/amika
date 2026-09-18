package sandboxcmd

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestAgentSendJSONAlwaysEmitsRequiredBools verifies that is_error and
// is_new_session are always present in the JSON, even when false. The API's
// AgentSendResponse marks both required, so a resumed session (is_new_session
// false) must still carry the field rather than dropping it via omitempty.
func TestAgentSendJSONAlwaysEmitsRequiredBools(t *testing.T) {
	data, err := json.Marshal(agentSendJSON{Sandbox: "sb", Agent: "claude", Status: "completed"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{`"is_error"`, `"is_new_session"`} {
		if !strings.Contains(string(data), key) {
			t.Errorf("expected %s to be present even when false, got: %s", key, data)
		}
	}
}

// TestAgentSendJSONResponsePresence verifies that a completed send emits the
// required "response" field even when the agent produced no text, while the
// async "sent" shape omits it (nil pointer). The API's AgentSendResponse marks
// response required, so a completed send with empty output must not drop it.
func TestAgentSendJSONResponsePresence(t *testing.T) {
	empty := ""

	completed, err := json.Marshal(agentSendJSON{Sandbox: "sb", Agent: "claude", Status: "completed", Response: &empty})
	if err != nil {
		t.Fatalf("marshal completed: %v", err)
	}
	if !strings.Contains(string(completed), `"response":""`) {
		t.Errorf("completed send must emit empty response, got: %s", completed)
	}

	sent, err := json.Marshal(agentSendJSON{Sandbox: "sb", Agent: "claude", Status: "sent"})
	if err != nil {
		t.Fatalf("marshal sent: %v", err)
	}
	if strings.Contains(string(sent), `"response"`) {
		t.Errorf("async sent shape must omit response, got: %s", sent)
	}
}

func TestResolveAgentConfig(t *testing.T) {
	t.Run("known agent claude", func(t *testing.T) {
		cfg, err := resolveAgentConfig("claude")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Binary != "claude" || cfg.PrintArg != "-p" || len(cfg.ExtraArgs) != 1 || cfg.ExtraArgs[0] != "--dangerously-skip-permissions" {
			t.Fatalf("got %+v, want claude/-p/--dangerously-skip-permissions", cfg)
		}
	})

	t.Run("known agent codex", func(t *testing.T) {
		cfg, err := resolveAgentConfig("codex")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Binary != "codex" {
			t.Fatalf("Binary = %q, want %q", cfg.Binary, "codex")
		}
		if len(cfg.SubCmd) != 1 || cfg.SubCmd[0] != "exec" {
			t.Fatalf("SubCmd = %v, want [exec]", cfg.SubCmd)
		}
		if len(cfg.ExtraArgs) != 1 || cfg.ExtraArgs[0] != "--dangerously-bypass-approvals-and-sandbox" {
			t.Fatalf("ExtraArgs = %v, want [--dangerously-bypass-approvals-and-sandbox]", cfg.ExtraArgs)
		}
	})

	t.Run("unknown agent returns error", func(t *testing.T) {
		_, err := resolveAgentConfig("custom-agent")
		if err == nil {
			t.Fatal("expected error for unknown agent, got nil")
		}
		if !strings.Contains(err.Error(), "unknown agent") {
			t.Fatalf("error = %q, want to contain 'unknown agent'", err.Error())
		}
	})
}

func TestAgentCmdPartsWithOpts(t *testing.T) {
	claude := knownAgents["claude"]

	t.Run("no opts no json", func(t *testing.T) {
		got := agentCmdPartsWithOpts(claude, "hello", agentRunOpts{}, false)
		want := []string{"claude", "--dangerously-skip-permissions", "-p", "hello"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("with session id maps to --resume", func(t *testing.T) {
		got := agentCmdPartsWithOpts(claude, "hello", agentRunOpts{SessionID: "abc-123"}, true)
		joined := strings.Join(got, " ")
		if !strings.Contains(joined, "--resume abc-123") {
			t.Fatalf("got %q, want --resume abc-123", joined)
		}
		if !strings.Contains(joined, "--output-format json") {
			t.Fatalf("got %q, want --output-format json", joined)
		}
	})

	t.Run("new session passes no session flag", func(t *testing.T) {
		got := agentCmdPartsWithOpts(claude, "hello", agentRunOpts{NewSession: true}, true)
		joined := strings.Join(got, " ")
		if strings.Contains(joined, "--new-session") {
			t.Fatalf("got %q, should not contain --new-session", joined)
		}
		if strings.Contains(joined, "--resume") {
			t.Fatalf("got %q, should not contain --resume", joined)
		}
		if strings.Contains(joined, "--continue") {
			t.Fatalf("got %q, should not contain --continue", joined)
		}
	})

	codex := knownAgents["codex"]

	t.Run("codex no opts no json", func(t *testing.T) {
		got := agentCmdPartsWithOpts(codex, "hello", agentRunOpts{}, false)
		want := []string{"codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "hello"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("codex with session id uses resume subcommand", func(t *testing.T) {
		got := agentCmdPartsWithOpts(codex, "hello", agentRunOpts{SessionID: "abc-123"}, true)
		joined := strings.Join(got, " ")
		want := "codex exec resume --dangerously-bypass-approvals-and-sandbox --json abc-123 hello"
		if joined != want {
			t.Fatalf("got %q, want %q", joined, want)
		}
	})

	t.Run("codex new session with json", func(t *testing.T) {
		got := agentCmdPartsWithOpts(codex, "hello", agentRunOpts{NewSession: true}, true)
		want := []string{"codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--json", "hello"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}

func TestBuildRemoteAgentShellCmd(t *testing.T) {
	claude := knownAgents["claude"]

	t.Run("wait mode includes json output", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", claude, agentRunOpts{})
		if !strings.Contains(got, "--output-format json") {
			t.Fatalf("cmd = %q, want --output-format json", got)
		}
	})

	t.Run("no-wait mode has no json and wraps in tmux", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", true, "/home/amika", claude, agentRunOpts{})
		if strings.Contains(got, "--output-format") {
			t.Fatalf("cmd = %q, should not contain --output-format in no-wait mode", got)
		}
		if !strings.Contains(got, "tmux new-session -d") {
			t.Fatalf("cmd = %q, want tmux wrap", got)
		}
	})

	t.Run("session id maps to --resume", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", claude, agentRunOpts{SessionID: "sess-42"})
		if !strings.Contains(got, "--resume sess-42") {
			t.Fatalf("cmd = %q, want --resume sess-42", got)
		}
	})

	t.Run("new session passes no session flag to claude", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", claude, agentRunOpts{NewSession: true})
		if strings.Contains(got, "--new-session") {
			t.Fatalf("cmd = %q, should not contain --new-session", got)
		}
		if strings.Contains(got, "--resume") {
			t.Fatalf("cmd = %q, should not contain --resume", got)
		}
		if !strings.Contains(got, "--output-format json") {
			t.Fatalf("cmd = %q, want --output-format json", got)
		}
	})

	codex := knownAgents["codex"]

	t.Run("codex wait mode includes --json", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", codex, agentRunOpts{})
		if !strings.Contains(got, "--json") {
			t.Fatalf("cmd = %q, want --json", got)
		}
		if !strings.Contains(got, "codex exec") {
			t.Fatalf("cmd = %q, want to contain 'codex exec'", got)
		}
	})

	t.Run("codex no-wait wraps in tmux without json", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", true, "/home/amika", codex, agentRunOpts{})
		if strings.Contains(got, "--json") {
			t.Fatalf("cmd = %q, should not contain --json in no-wait mode", got)
		}
		if !strings.Contains(got, "tmux new-session -d") {
			t.Fatalf("cmd = %q, want tmux wrap", got)
		}
	})

	t.Run("codex session id uses resume subcommand", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", codex, agentRunOpts{SessionID: "sess-42"})
		if !strings.Contains(got, "codex exec resume") {
			t.Fatalf("cmd = %q, want 'codex exec resume'", got)
		}
		if !strings.Contains(got, "sess-42") {
			t.Fatalf("cmd = %q, want session ID 'sess-42'", got)
		}
	})
}
