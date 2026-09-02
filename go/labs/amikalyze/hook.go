package amikalyze

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"
)

// Source identifies an agent hook payload format.
type Source string

const (
	// SourceClaude identifies Claude Code Edit and Write hook payloads.
	SourceClaude Source = "claude"
	// SourceCodex identifies Codex apply_patch hook payloads.
	SourceCodex Source = "codex"
)

type hookInput struct {
	CWD           string          `json:"cwd"`
	HookEventName string          `json:"hook_event_name"`
	ToolName      string          `json:"tool_name"`
	ToolInput     json.RawMessage `json:"tool_input"`
}

// HookDecision contains the policy decisions for one agent tool call.
type HookDecision struct {
	Decisions []Decision
}

// Frozen reports whether the entire tool call must be denied.
func (d HookDecision) Frozen() bool {
	for _, decision := range d.Decisions {
		if decision.Frozen() {
			return true
		}
	}
	return false
}

// EvaluateHook parses one PreToolUse payload and evaluates every file the tool
// call would modify. A multi-file call is frozen when any target is frozen.
func EvaluateHook(source Source, input io.Reader, overrides Overrides) (HookDecision, error) {
	var payload hookInput
	decoder := json.NewDecoder(input)
	if err := decoder.Decode(&payload); err != nil {
		return HookDecision{}, fmt.Errorf("parsing %s hook input: %w", source, err)
	}
	if payload.CWD == "" {
		return HookDecision{}, errors.New("hook input is missing cwd")
	}
	if payload.HookEventName != "PreToolUse" {
		return HookDecision{}, fmt.Errorf("unexpected hook event %q", payload.HookEventName)
	}

	targets, err := hookTargets(source, payload)
	if err != nil {
		return HookDecision{}, err
	}
	repoRoot, err := RepositoryRoot(payload.CWD)
	if errors.Is(err, ErrNotRepository) {
		return HookDecision{}, nil
	}
	if err != nil {
		return HookDecision{}, err
	}

	result := HookDecision{Decisions: make([]Decision, 0, len(targets))}
	for _, target := range targets {
		if !filepath.IsAbs(target) {
			target = filepath.Join(payload.CWD, target)
		}
		if _, inside := relativeInside(repoRoot, filepath.Clean(target)); !inside {
			continue
		}
		decision, err := Evaluate(repoRoot, target, overrides)
		if err != nil {
			return result, err
		}
		result.Decisions = append(result.Decisions, decision)
	}
	return result, nil
}

// DenialReason returns concise model-visible feedback for a denied tool call.
func (d HookDecision) DenialReason() string {
	var lines []string
	for _, decision := range d.Decisions {
		for _, match := range decision.Matches {
			lines = append(lines, fmt.Sprintf(
				"- %s: freeze %q matched %q in %s",
				decision.RepoPath, match.Label, match.Pattern, match.ConfigPath,
			))
		}
	}
	sort.Strings(lines)
	return "Amikalyze blocked this edit:\n" + strings.Join(lines, "\n") +
		"\nOnly a human may unfreeze these paths. Do not retry with another tool or shell command."
}

func hookTargets(source Source, payload hookInput) ([]string, error) {
	switch source {
	case SourceClaude:
		if payload.ToolName != "Edit" && payload.ToolName != "Write" {
			return nil, fmt.Errorf("unexpected Claude tool %q", payload.ToolName)
		}
		var input struct {
			FilePath string `json:"file_path"`
		}
		if err := json.Unmarshal(payload.ToolInput, &input); err != nil {
			return nil, fmt.Errorf("parsing Claude %s input: %w", payload.ToolName, err)
		}
		if input.FilePath == "" {
			return nil, fmt.Errorf("Claude %s input is missing file_path", payload.ToolName)
		}
		return []string{input.FilePath}, nil
	case SourceCodex:
		if payload.ToolName != "apply_patch" {
			return nil, fmt.Errorf("unexpected Codex tool %q", payload.ToolName)
		}
		var input struct {
			Command string `json:"command"`
		}
		if err := json.Unmarshal(payload.ToolInput, &input); err != nil {
			return nil, fmt.Errorf("parsing Codex apply_patch input: %w", err)
		}
		return parsePatchTargets(input.Command)
	default:
		return nil, fmt.Errorf("unknown hook source %q", source)
	}
}

func parsePatchTargets(patch string) ([]string, error) {
	lines := strings.Split(strings.ReplaceAll(patch, "\r\n", "\n"), "\n")
	if len(lines) < 2 || lines[0] != "*** Begin Patch" {
		return nil, errors.New("Codex apply_patch input is missing Begin Patch marker")
	}
	targets := make(map[string]struct{})
	ended := false
	for _, line := range lines[1:] {
		if line == "*** End Patch" {
			ended = true
			break
		}
		for _, prefix := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
			if !strings.HasPrefix(line, prefix) {
				continue
			}
			target := strings.TrimSpace(strings.TrimPrefix(line, prefix))
			if target == "" {
				return nil, fmt.Errorf("Codex apply_patch has an empty %s target", strings.TrimSpace(prefix))
			}
			targets[target] = struct{}{}
		}
	}
	if !ended {
		return nil, errors.New("Codex apply_patch input is missing End Patch marker")
	}
	if len(targets) == 0 {
		return nil, errors.New("Codex apply_patch input contains no file targets")
	}
	result := make([]string, 0, len(targets))
	for target := range targets {
		result = append(result, target)
	}
	sort.Strings(result)
	return result, nil
}
