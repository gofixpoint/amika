package amikalyze

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const binaryName = "amikalyze"

// Agent identifies a supported coding-agent hook configuration.
type Agent string

const (
	// AgentClaude installs a Claude Code PreToolUse hook.
	AgentClaude Agent = "claude"
	// AgentCodex installs a Codex PreToolUse hook.
	AgentCodex Agent = "codex"
)

// HookCommand is the command installed into an agent's hook configuration.
type HookCommand struct {
	Exe string
}

// DefaultHookCommand returns a hook command using the running executable.
func DefaultHookCommand() (HookCommand, error) {
	executable, err := os.Executable()
	if err != nil {
		return HookCommand{}, fmt.Errorf("resolving amikalyze executable: %w", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return HookCommand{}, fmt.Errorf("resolving absolute amikalyze executable: %w", err)
	}
	return HookCommand{Exe: executable}, nil
}

// Command returns the shell command installed for agent.
func (h HookCommand) Command(agent Agent) string {
	return fmt.Sprintf("%s hook --source %s", shellQuote(h.Exe), agent)
}

// InstallReport describes one selected agent's hook configuration update.
type InstallReport struct {
	Agent   Agent
	Path    string
	Updated bool
}

// InstallHooks installs the amikalyze PreToolUse hook for selected agents.
func InstallHooks(homeDir string, agents []Agent, command HookCommand) ([]InstallReport, error) {
	return mutateAgentHooks(homeDir, agents, func(path string, agent Agent) (bool, error) {
		return ensureAgentHook(path, agent, command)
	})
}

// UninstallHooks removes amikalyze hooks for selected agents while preserving
// unrelated configuration.
func UninstallHooks(homeDir string, agents []Agent) ([]InstallReport, error) {
	return mutateAgentHooks(homeDir, agents, removeAgentHook)
}

func mutateAgentHooks(homeDir string, agents []Agent, mutate func(string, Agent) (bool, error)) ([]InstallReport, error) {
	if len(agents) == 0 {
		return nil, errors.New("at least one agent is required")
	}
	reports := make([]InstallReport, 0, len(agents))
	seen := make(map[Agent]struct{}, len(agents))
	for _, agent := range agents {
		if _, duplicate := seen[agent]; duplicate {
			continue
		}
		seen[agent] = struct{}{}
		path, err := agentHooksPath(homeDir, agent)
		if err != nil {
			return reports, err
		}
		updated, err := mutate(path, agent)
		if err != nil {
			return reports, err
		}
		reports = append(reports, InstallReport{Agent: agent, Path: path, Updated: updated})
	}
	return reports, nil
}

func agentHooksPath(homeDir string, agent Agent) (string, error) {
	switch agent {
	case AgentClaude:
		return filepath.Join(homeDir, ".claude", "settings.json"), nil
	case AgentCodex:
		codexHome := os.Getenv("CODEX_HOME")
		if codexHome == "" {
			codexHome = filepath.Join(homeDir, ".codex")
		}
		return filepath.Join(codexHome, "hooks.json"), nil
	default:
		return "", fmt.Errorf("unsupported agent %q (want claude or codex)", agent)
	}
}

func ensureAgentHook(filename string, agent Agent, command HookCommand) (bool, error) {
	object, err := readJSONObject(filename)
	if err != nil {
		return false, err
	}
	before, err := json.Marshal(object)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", filename, err)
	}
	hooks, _ := object["hooks"].(map[string]interface{})
	if hooks == nil {
		hooks = make(map[string]interface{})
	}
	groups, _ := hooks["PreToolUse"].([]interface{})
	groups, _ = stripAgentHooks(groups, agent)
	matcher := "Edit|Write"
	if agent == AgentCodex {
		matcher = "^apply_patch$"
	}
	groups = append(groups, map[string]interface{}{
		"matcher": matcher,
		"hooks": []interface{}{map[string]interface{}{
			"type":    "command",
			"command": command.Command(agent),
			"timeout": float64(3),
		}},
	})
	hooks["PreToolUse"] = groups
	object["hooks"] = hooks
	return writeJSONObjectIfChanged(filename, object, before)
}

func removeAgentHook(filename string, agent Agent) (bool, error) {
	object, err := readJSONObject(filename)
	if err != nil {
		return false, err
	}
	before, err := json.Marshal(object)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", filename, err)
	}
	hooks, _ := object["hooks"].(map[string]interface{})
	if hooks == nil {
		return false, nil
	}
	groups, _ := hooks["PreToolUse"].([]interface{})
	filtered, removed := stripAgentHooks(groups, agent)
	if !removed {
		return false, nil
	}
	if len(filtered) == 0 {
		delete(hooks, "PreToolUse")
	} else {
		hooks["PreToolUse"] = filtered
	}
	if len(hooks) == 0 {
		delete(object, "hooks")
	} else {
		object["hooks"] = hooks
	}
	return writeJSONObjectIfChanged(filename, object, before)
}

func stripAgentHooks(groups []interface{}, agent Agent) ([]interface{}, bool) {
	filtered := make([]interface{}, 0, len(groups))
	removed := false
	for _, rawGroup := range groups {
		group, ok := rawGroup.(map[string]interface{})
		if !ok {
			filtered = append(filtered, rawGroup)
			continue
		}
		entries, _ := group["hooks"].([]interface{})
		kept := make([]interface{}, 0, len(entries))
		for _, rawEntry := range entries {
			entry, ok := rawEntry.(map[string]interface{})
			if !ok {
				kept = append(kept, rawEntry)
				continue
			}
			command, _ := entry["command"].(string)
			if isManagedHook(command, agent) {
				removed = true
				continue
			}
			kept = append(kept, rawEntry)
		}
		if len(kept) == 0 {
			continue
		}
		group["hooks"] = kept
		filtered = append(filtered, group)
	}
	return filtered, removed
}

func isManagedHook(command string, agent Agent) bool {
	args := splitShellArgs(command)
	return len(args) == 4 && filepath.Base(args[0]) == binaryName &&
		args[1] == "hook" && args[2] == "--source" && args[3] == string(agent)
}

func splitShellArgs(value string) []string {
	var result []string
	var current strings.Builder
	inSingle := false
	started := false
	for i := 0; i < len(value); i++ {
		character := value[i]
		if inSingle {
			if character == '\'' {
				inSingle = false
			} else {
				current.WriteByte(character)
				started = true
			}
			continue
		}
		switch {
		case character == '\\' && i+1 < len(value):
			i++
			current.WriteByte(value[i])
			started = true
		case character == '\'':
			inSingle = true
			started = true
		case character == ' ' || character == '\t':
			if started {
				result = append(result, current.String())
				current.Reset()
				started = false
			}
		default:
			current.WriteByte(character)
			started = true
		}
	}
	if started {
		result = append(result, current.String())
	}
	return result
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func readJSONObject(filename string) (map[string]interface{}, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return make(map[string]interface{}), nil
		}
		return nil, fmt.Errorf("reading %s: %w", filename, err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return make(map[string]interface{}), nil
	}
	var object map[string]interface{}
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", filename, err)
	}
	if object == nil {
		object = make(map[string]interface{})
	}
	return object, nil
}

func writeJSONObjectIfChanged(filename string, object map[string]interface{}, before []byte) (bool, error) {
	after, err := json.Marshal(object)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", filename, err)
	}
	if bytes.Equal(before, after) {
		return false, nil
	}
	encoded, err := json.MarshalIndent(object, "", "  ")
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", filename, err)
	}
	encoded = append(encoded, '\n')
	return true, writeFileAtomic(filename, encoded)
}

func writeFileAtomic(filename string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return fmt.Errorf("creating directory for %s: %w", filename, err)
	}
	mode := os.FileMode(0o600)
	if info, err := os.Stat(filename); err == nil {
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stating %s: %w", filename, err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(filename), ".amikalyze-*")
	if err != nil {
		return fmt.Errorf("creating temporary file for %s: %w", filename, err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return fmt.Errorf("setting permissions for %s: %w", filename, err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("writing %s: %w", filename, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("closing temporary file for %s: %w", filename, err)
	}
	if err := os.Rename(temporaryName, filename); err != nil {
		return fmt.Errorf("replacing %s: %w", filename, err)
	}
	return nil
}
