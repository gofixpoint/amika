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

// hookTarget is one path a tool call modifies.
type hookTarget struct {
	path string
	// writesThrough reports whether the call writes the file's contents, which
	// follows path when it is a symlink. Deleting a file or renaming it away
	// acts on the symlink itself and leaves its destination untouched.
	writesThrough bool
}

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
		// Joined without cleaning: a lexical ".." after a symlink would change
		// which file the path names (see resolvePath).
		if !filepath.IsAbs(target.path) {
			target.path = payload.CWD + string(filepath.Separator) + target.path
		}
		candidates, err := repoCandidates(repoRoot, target)
		if err != nil {
			return result, err
		}
		for _, candidate := range candidates {
			decision, err := Evaluate(repoRoot, candidate, overrides)
			if err != nil {
				return result, err
			}
			result.Decisions = append(result.Decisions, decision)
		}
	}
	return result, nil
}

// repoCandidates returns the repository paths a change to target touches: the
// path as written, and the physical location it changes when a symlink leads
// elsewhere in the repository. Freezes apply to both, so neither a symlink out
// of a frozen path nor one into it evades them. Targets outside the repository
// on both counts yield nothing.
func repoCandidates(repoRoot string, target hookTarget) ([]string, error) {
	var candidates []string
	if repoPath, inside := repoRelative(repoRoot, target.path); inside {
		candidates = append(candidates, filepath.Join(repoRoot, repoPath))
	}
	physical, err := resolvePath(target.path, target.writesThrough)
	if err != nil {
		return nil, fmt.Errorf("resolving target path: %w", err)
	}
	if repoPath, inside := relativeInside(repoRoot, physical); inside {
		physical = filepath.Join(repoRoot, repoPath)
		if len(candidates) == 0 || candidates[0] != physical {
			candidates = append(candidates, physical)
		}
	}
	return candidates, nil
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

func hookTargets(source Source, payload hookInput) ([]hookTarget, error) {
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
		return []hookTarget{{path: input.FilePath, writesThrough: true}}, nil
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

func parsePatchTargets(patch string) ([]hookTarget, error) {
	lines := strings.Split(strings.ReplaceAll(patch, "\r\n", "\n"), "\n")
	if len(lines) < 2 || lines[0] != "*** Begin Patch" {
		return nil, errors.New("Codex apply_patch input is missing Begin Patch marker")
	}
	var operations []hookTarget
	// updated indexes the operation for the latest Update File header, whose
	// file a following Move to renames away rather than writes through.
	updated := -1
	ended := false
	for _, line := range lines[1:] {
		if line == "*** End Patch" {
			ended = true
			break
		}
		for _, op := range []struct {
			prefix        string
			writesThrough bool
		}{
			{"*** Add File: ", true},
			{"*** Update File: ", true},
			{"*** Delete File: ", false},
			{"*** Move to: ", true},
		} {
			if !strings.HasPrefix(line, op.prefix) {
				continue
			}
			target := strings.TrimSpace(strings.TrimPrefix(line, op.prefix))
			if target == "" {
				return nil, fmt.Errorf("Codex apply_patch has an empty %s target", strings.TrimSpace(op.prefix))
			}
			if op.prefix == "*** Move to: " && updated >= 0 {
				operations[updated].writesThrough = false
			}
			updated = -1
			if op.prefix == "*** Update File: " {
				updated = len(operations)
			}
			operations = append(operations, hookTarget{path: target, writesThrough: op.writesThrough})
		}
	}
	if !ended {
		return nil, errors.New("Codex apply_patch input is missing End Patch marker")
	}
	if len(operations) == 0 {
		return nil, errors.New("Codex apply_patch input contains no file targets")
	}
	// A path several operations name writes through if any of them does.
	targets := make(map[string]bool)
	for _, operation := range operations {
		targets[operation.path] = targets[operation.path] || operation.writesThrough
	}
	result := make([]hookTarget, 0, len(targets))
	for target, writesThrough := range targets {
		result = append(result, hookTarget{path: target, writesThrough: writesThrough})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].path < result[j].path })
	return result, nil
}
