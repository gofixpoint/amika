package sandboxcmd

// sandbox_agent.go implements agent-send command wiring and agent CLI helpers.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/config"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

type agentConfig struct {
	Binary         string
	SubCmd         []string
	PrintArg       string
	ExtraArgs      []string
	ResumeSubCmd   []string
	ResumeFlag     string
	JSONOutputArgs []string
}

var knownAgents = map[string]agentConfig{
	"claude": {
		Binary:         "claude",
		PrintArg:       "-p",
		ExtraArgs:      []string{"--dangerously-skip-permissions"},
		ResumeFlag:     "--resume",
		JSONOutputArgs: []string{"--output-format", "json"},
	},
	"codex": {
		Binary:         "codex",
		SubCmd:         []string{"exec"},
		ExtraArgs:      []string{"--dangerously-bypass-approvals-and-sandbox"},
		ResumeSubCmd:   []string{"resume"},
		JSONOutputArgs: []string{"--json"},
	},
}

func resolveAgentConfig(name string) (agentConfig, error) {
	if cfg, ok := knownAgents[name]; ok {
		return cfg, nil
	}
	known := make([]string, 0, len(knownAgents))
	for k := range knownAgents {
		known = append(known, fmt.Sprintf("%q", k))
	}
	return agentConfig{}, fmt.Errorf("unknown agent %q; supported agents: %s", name, strings.Join(known, ", "))
}

func runDockerSandboxAgentSend(name, message string, noWait bool, workdir string, agent agentConfig, stdout, stderr io.Writer) error {
	dockerArgs := buildDockerAgentSendArgs(name, message, noWait, workdir, agent)
	dockerCmd := exec.Command("docker", dockerArgs...)
	if !noWait {
		dockerCmd.Stdout = stdout
		dockerCmd.Stderr = stderr
	}
	return dockerCmd.Run()
}

type agentRunOpts struct {
	SessionID  string
	NewSession bool
}

func agentCmdParts(agent agentConfig, message string) []string {
	parts := []string{agent.Binary}
	parts = append(parts, agent.SubCmd...)
	parts = append(parts, agent.ExtraArgs...)
	if agent.PrintArg != "" {
		parts = append(parts, agent.PrintArg)
	}
	parts = append(parts, message)
	return parts
}

func agentCmdPartsWithOpts(agent agentConfig, message string, opts agentRunOpts, jsonOutput bool) []string {
	parts := []string{agent.Binary}
	parts = append(parts, agent.SubCmd...)
	if opts.SessionID != "" {
		parts = append(parts, agent.ResumeSubCmd...)
	}
	parts = append(parts, agent.ExtraArgs...)
	if opts.SessionID != "" && agent.ResumeFlag != "" {
		parts = append(parts, agent.ResumeFlag, opts.SessionID)
	}
	if jsonOutput {
		parts = append(parts, agent.JSONOutputArgs...)
	}
	if opts.SessionID != "" && agent.ResumeFlag == "" {
		parts = append(parts, opts.SessionID)
	}
	if agent.PrintArg != "" {
		parts = append(parts, agent.PrintArg)
	}
	parts = append(parts, message)
	return parts
}

func buildAgentShellCmd(message string, noWait bool, workdir string, agent agentConfig) string {
	agentStr := strings.Join(agentCmdParts(agent, fmt.Sprintf("%q", message)), " ")
	cmd := fmt.Sprintf("cd %s && %s", workdir, agentStr)
	if noWait {
		sessionName := fmt.Sprintf("amika-agent-send-%d", time.Now().UnixNano())
		return fmt.Sprintf("tmux new-session -d -s '%s' '%s'", sessionName, cmd)
	}
	return cmd
}

func buildRemoteAgentShellCmd(message string, noWait bool, workdir string, agent agentConfig, opts agentRunOpts) string {
	agentStr := strings.Join(agentCmdPartsWithOpts(agent, fmt.Sprintf("%q", message), opts, !noWait), " ")
	cmd := fmt.Sprintf("cd %s && %s", workdir, agentStr)
	if noWait {
		sessionName := fmt.Sprintf("amika-agent-send-%d", time.Now().UnixNano())
		return fmt.Sprintf("tmux new-session -d -s '%s' '%s'", sessionName, cmd)
	}
	return cmd
}

// agentSendJSON is the JSON rendering of a synchronous agent-send result,
// emitted to stdout when --output json is set.
type agentSendJSON struct {
	SessionID      string `json:"session_id"`
	AgentSessionID string `json:"agent_session_id,omitempty"`
	Response       string `json:"response"`
	IsError        bool   `json:"is_error"`
}

// checkAgentSendOutputMode rejects JSON output for agent-send modes that stream
// raw agent output rather than a structured result. Only synchronous remote
// sends buffer the response into the JSON object, so --local and --no-wait
// cannot honor --output json and must fail fast instead of silently emitting
// non-JSON text.
func checkAgentSendOutputMode(format output.Format, mode runmode.Mode, noWait bool) error {
	if format != output.JSON {
		return nil
	}
	if mode == runmode.Local {
		return fmt.Errorf("--output json is not supported with --local; only synchronous remote sends produce structured output")
	}
	if noWait {
		return fmt.Errorf("--output json is not supported with --no-wait; only synchronous sends produce structured output")
	}
	return nil
}

func runRemoteAgentSend(client *apiclient.Client, name, message string, noWait bool, workdir string, agent agentConfig, opts agentRunOpts, format output.Format, stdout, stderr io.Writer) error {
	if noWait {
		shellCmd := buildRemoteAgentShellCmd(message, noWait, workdir, agent, opts)
		return ssh.ExecSSH(client, name, false, []string{shellCmd})
	}

	req := apiclient.AgentSendRequest{
		Message:    message,
		NewSession: opts.NewSession,
		SessionID:  opts.SessionID,
		Agent:      agent.Binary,
	}

	resp, err := client.AgentSend(name, req)
	if err != nil {
		return fmt.Errorf("agent-send failed for sandbox %q: %w", name, err)
	}

	if err := writeAgentSendResult(resp, format, stdout, stderr); err != nil {
		return err
	}

	if resp.IsError {
		return fmt.Errorf("agent returned an error in sandbox %q", name)
	}
	return nil
}

// writeAgentSendResult renders a synchronous agent-send response. In text mode
// the agent response goes to stdout and the session id (if any) to stderr,
// keeping stdout the pure agent output. In JSON mode a single object with the
// session id, response, and error status is written to stdout.
func writeAgentSendResult(resp *apiclient.AgentSendResponse, format output.Format, stdout, stderr io.Writer) error {
	if format == output.JSON {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(agentSendJSON{
			SessionID:      resp.SessionID,
			AgentSessionID: resp.AgentSessionID,
			Response:       resp.Result,
			IsError:        resp.IsError,
		}); err != nil {
			return fmt.Errorf("failed to encode agent-send response as JSON: %w", err)
		}
		return nil
	}

	fmt.Fprint(stdout, resp.Result)
	if resp.Result != "" && !strings.HasSuffix(resp.Result, "\n") {
		fmt.Fprintln(stdout)
	}
	if resp.SessionID != "" {
		fmt.Fprintf(stderr, "session_id: %s\n", resp.SessionID)
	}
	return nil
}

func buildDockerAgentSendArgs(name, message string, noWait bool, workdir string, agent agentConfig) []string {
	shellCmd := buildAgentShellCmd(message, noWait, workdir, agent)
	return []string{"exec", name, "bash", "-c", shellCmd}
}

func isStdinPiped() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) == 0
}

var sandboxAgentSendCmd = &cobra.Command{
	Use:   "agent-send <name> [message]",
	Short: "Send a message to an agent in a sandbox",
	Long: `Send a prompt to an AI agent CLI running inside a sandbox container.
The message can be provided as a positional argument or piped via stdin.
By default the command waits for the agent to finish and streams the response.
Use --no-wait to send the message and return immediately.

For synchronous remote sends, the agent session id is surfaced so the session
can be resumed with --session-id. In text output (the default) the response is
written to stdout and "session_id: <id>" to stderr, keeping stdout the pure
agent response. With --output json, the session id, response, and error status
are written to stdout as a single JSON object instead. --output json requires a
synchronous remote send; it is rejected with --local or --no-wait, which stream
raw agent output and produce no structured result.`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		name := args[0]

		var message string
		if len(args) > 1 {
			message = strings.Join(args[1:], " ")
		} else if isStdinPiped() {
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				return fmt.Errorf("failed to read message from stdin: %w", err)
			}
			message = strings.TrimSpace(string(data))
		}
		if message == "" {
			return fmt.Errorf("message is required as an argument or via stdin")
		}

		noWait, _ := cmd.Flags().GetBool("no-wait")
		workdir, _ := cmd.Flags().GetString("workdir")
		agentName, _ := cmd.Flags().GetString("agent")
		agent, err := resolveAgentConfig(agentName)
		if err != nil {
			return err
		}

		format, err := output.Resolve(cmd)
		if err != nil {
			return err
		}

		target, err := getRemoteTarget(cmd)
		if err != nil {
			return err
		}

		mode := runmode.Resolve(cmd)
		if err := checkAgentSendOutputMode(format, mode, noWait); err != nil {
			return err
		}
		if err := runmode.RequireAuth(mode, runmode.DefaultAuthChecker); err != nil {
			return err
		}

		if mode == runmode.Local {
			sandboxesFile, err := config.SandboxesStateFile()
			if err != nil {
				return err
			}
			store := sandbox.NewStore(sandboxesFile)
			info, err := store.Get(name)
			if err != nil {
				return fmt.Errorf("sandbox %q not found", name)
			}
			if info.Provider != "docker" {
				return fmt.Errorf("unsupported local provider %q: only \"docker\" is supported", info.Provider)
			}
			if err := runDockerSandboxAgentSend(name, message, noWait, workdir, agent, os.Stdout, os.Stderr); err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 127 {
					return fmt.Errorf("%s CLI not found in sandbox %q; was it created with the right preset?", agent.Binary, name)
				}
				return fmt.Errorf("agent-send failed for sandbox %q: %w", name, err)
			}
			if noWait {
				fmt.Fprintf(os.Stderr, "Message sent to %s in sandbox %q\n", agent.Binary, name)
			}
			return nil
		}

		client, err := getRemoteClient(target)
		if err != nil {
			return err
		}

		sessionID, _ := cmd.Flags().GetString("session-id")
		newSession, _ := cmd.Flags().GetBool("new-session")
		opts := agentRunOpts{SessionID: sessionID, NewSession: newSession}

		if err := runRemoteAgentSend(client, name, message, noWait, workdir, agent, opts, format, os.Stdout, os.Stderr); err != nil {
			return err
		}
		if noWait {
			fmt.Fprintf(os.Stderr, "Message sent to %s in sandbox %q\n", agent.Binary, name)
		}
		return nil
	},
}
