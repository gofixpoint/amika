package eventlog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// binaryName is the basename amikalog hook entries are recognized by, so a
// rename of the installed binary's path does not strand stale config entries.
const binaryName = "amikalog"

// claudeHookEvents is the set of Claude Code hook events amikalog registers
// for. The same command handles them all; it reads the specific event from the
// payload's hook_event_name field.
//
// This is the agent-activity subset of Claude's full hook catalog (see
// https://code.claude.com/docs/en/hooks): tool use, prompts, permissions,
// subagents, tasks, turns, compaction and session lifecycle. Purely UI or
// environment events (FileChanged, MessageDisplay, CwdChanged, TeammateIdle,
// WorktreeCreate/Remove, ConfigChange, Elicitation, ...) are intentionally
// omitted to keep the log signal-bearing rather than a firehose.
var claudeHookEvents = []string{
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Notification",
	"SubagentStart",
	"SubagentStop",
	"TaskCreated",
	"TaskCompleted",
	"Stop",
	"StopFailure",
	"PreCompact",
	"PostCompact",
	"SessionEnd",
}

// codexHookEvents is every Codex lifecycle hook event amikalog registers for in
// ~/.codex/hooks.json. Codex delivers the payload on stdin with the same shape
// as Claude (session_id, cwd, hook_event_name), so one command handles them all.
// See https://developers.openai.com/codex/hooks.
var codexHookEvents = []string{
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SubagentStart",
	"SubagentStop",
	"Stop",
}

// claudeMatcher returns the matcher for a Claude hook group. Claude treats an
// omitted matcher as "match all" for every event type, so amikalog never sets
// one: it wants every invocation regardless of tool name, agent type, etc.
func claudeMatcher(string) (string, bool) {
	return "", false
}

// codexMatcher returns the matcher for a Codex hook group. Codex matchers are
// regexes; ".*" matches every tool/source, so all events fire.
func codexMatcher(string) (string, bool) {
	return ".*", true
}

// HookCommand is the command Claude/Codex hooks invoke to capture events.
// Exposed so callers (and tests) can swap the executable.
type HookCommand struct {
	// Exe is the absolute path or bare name of the amikalog executable.
	Exe string
}

// DefaultHookCommand returns a HookCommand using the running amikalog binary.
func DefaultHookCommand() (HookCommand, error) {
	exe, err := os.Executable()
	if err != nil {
		return HookCommand{}, fmt.Errorf("resolving amikalog executable: %w", err)
	}
	abs, err := filepath.Abs(exe)
	if err != nil {
		return HookCommand{}, fmt.Errorf("resolving absolute path of amikalog executable: %w", err)
	}
	return HookCommand{Exe: abs}, nil
}

// ClaudeCommand returns the shell command a Claude hook should run.
func (h HookCommand) ClaudeCommand() string {
	return fmt.Sprintf("%s hook --source claude", shellQuote(h.Exe))
}

// CodexCommand returns the shell command a Codex lifecycle hook should run.
func (h HookCommand) CodexCommand() string {
	return fmt.Sprintf("%s hook --source codex", shellQuote(h.Exe))
}

// hookSpec describes how a source's hook entries are written into a hooks JSON
// object and recognized for replacement/removal.
type hookSpec struct {
	command   string                            // shell command each hook runs
	events    []string                          // events to register
	matcher   func(event string) (string, bool) // optional per-event matcher
	isManaged func(cmd string) bool             // recognizes amikalog-owned entries
}

func claudeSpec(cmd HookCommand) hookSpec {
	return hookSpec{cmd.ClaudeCommand(), claudeHookEvents, claudeMatcher, isManagedClaudeHook}
}

func codexSpec(cmd HookCommand) hookSpec {
	return hookSpec{cmd.CodexCommand(), codexHookEvents, codexMatcher, isManagedCodexHook}
}

// InitReport summarizes what Init (or Uninstall) did so the CLI can print
// useful feedback. The *Updated fields are false when nothing changed.
type InitReport struct {
	ClaudeSettingsPath string
	ClaudeUpdated      bool
	CodexHooksPath     string
	CodexUpdated       bool
	CodexConfigPath    string
	CodexNotifyRemoved bool // a managed `notify` program was cleaned out of config.toml
}

// Init wires amikalog hooks into Claude Code's settings and Codex's hooks.json
// (one entry per lifecycle event), under homeDir. The Codex side honors
// $CODEX_HOME (see CodexHome). Any managed `notify` program left in Codex's
// config.toml (from a previous amikalog version or the removed amika capture)
// is cleaned out, since lifecycle hooks supersede it; a third-party notify is
// left alone. Init is idempotent: running it twice is a no-op.
func Init(homeDir string, cmd HookCommand) (InitReport, error) {
	rep := InitReport{
		ClaudeSettingsPath: filepath.Join(homeDir, ".claude", "settings.json"),
		CodexHooksPath:     CodexHooksFile(homeDir),
		CodexConfigPath:    filepath.Join(CodexHome(homeDir), "config.toml"),
	}

	claudeUpdated, err := ensureHooks(rep.ClaudeSettingsPath, claudeSpec(cmd))
	if err != nil {
		return rep, err
	}
	rep.ClaudeUpdated = claudeUpdated

	codexUpdated, err := ensureHooks(rep.CodexHooksPath, codexSpec(cmd))
	if err != nil {
		return rep, err
	}
	rep.CodexUpdated = codexUpdated

	notifyRemoved, err := removeCodexNotify(rep.CodexConfigPath)
	if err != nil {
		return rep, err
	}
	rep.CodexNotifyRemoved = notifyRemoved

	return rep, nil
}

// Uninstall removes amikalog hooks from Claude Code's settings and Codex's
// hooks.json, and cleans out any managed Codex `notify` program, leaving
// unrelated entries untouched. Its InitReport reuses the *Updated fields to
// report whether anything was removed.
func Uninstall(homeDir string) (InitReport, error) {
	rep := InitReport{
		ClaudeSettingsPath: filepath.Join(homeDir, ".claude", "settings.json"),
		CodexHooksPath:     CodexHooksFile(homeDir),
		CodexConfigPath:    filepath.Join(CodexHome(homeDir), "config.toml"),
	}

	claudeUpdated, err := removeManagedHooks(rep.ClaudeSettingsPath, claudeHookEvents, isManagedClaudeHook)
	if err != nil {
		return rep, err
	}
	rep.ClaudeUpdated = claudeUpdated

	codexUpdated, err := removeManagedHooks(rep.CodexHooksPath, codexHookEvents, isManagedCodexHook)
	if err != nil {
		return rep, err
	}
	rep.CodexUpdated = codexUpdated

	notifyRemoved, err := removeCodexNotify(rep.CodexConfigPath)
	if err != nil {
		return rep, err
	}
	rep.CodexNotifyRemoved = notifyRemoved

	return rep, nil
}

// ensureHooks reads a hooks JSON object (Claude's settings.json or Codex's
// hooks.json — same `{"hooks": {Event: [{matcher?, hooks: [...]}]}}` shape) and
// makes every event in spec run spec.command exactly once, writing the file
// back. Prior amikalog entries are stripped first (recognized by argv shape,
// not exact string) so re-running from a different executable path replaces
// stale entries rather than appending duplicates. Unrelated keys and hooks
// round-trip unchanged. Returns whether the file changed.
//
// Schemas: https://docs.claude.com/en/docs/claude-code/hooks and
// https://developers.openai.com/codex/hooks.
func ensureHooks(path string, spec hookSpec) (bool, error) {
	obj, err := readJSONObject(path)
	if err != nil {
		return false, err
	}
	before, err := json.Marshal(obj)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}

	hooks, _ := obj["hooks"].(map[string]interface{})
	if hooks == nil {
		hooks = map[string]interface{}{}
	}
	for _, event := range spec.events {
		groups, _ := hooks[event].([]interface{})
		filtered, _ := stripManagedHooks(groups, spec.isManaged)
		group := map[string]interface{}{
			"hooks": []interface{}{
				map[string]interface{}{"type": "command", "command": spec.command},
			},
		}
		if m, ok := spec.matcher(event); ok {
			group["matcher"] = m
		}
		hooks[event] = append(filtered, group)
	}
	obj["hooks"] = hooks

	after, err := json.Marshal(obj)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}
	if bytes.Equal(before, after) {
		return false, nil
	}
	return true, writeJSONObject(path, obj)
}

// removeManagedHooks strips every amikalog entry from the given events, dropping
// events (and the hooks object) that become empty. Returns whether the file
// changed.
func removeManagedHooks(path string, events []string, isManaged func(string) bool) (bool, error) {
	obj, err := readJSONObject(path)
	if err != nil {
		return false, err
	}
	hooks, _ := obj["hooks"].(map[string]interface{})
	if hooks == nil {
		return false, nil
	}
	before, err := json.Marshal(obj)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}

	for _, event := range events {
		groups, _ := hooks[event].([]interface{})
		if groups == nil {
			continue
		}
		filtered, _ := stripManagedHooks(groups, isManaged)
		if len(filtered) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = filtered
		}
	}
	if len(hooks) == 0 {
		delete(obj, "hooks")
	} else {
		obj["hooks"] = hooks
	}

	after, err := json.Marshal(obj)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}
	if bytes.Equal(before, after) {
		return false, nil
	}
	return true, writeJSONObject(path, obj)
}

// stripManagedHooks returns the input hook groups with every entry matched by
// isManaged removed (groups that become empty are dropped), plus the raw
// command strings of the entries that were removed.
func stripManagedHooks(groups []interface{}, isManaged func(string) bool) ([]interface{}, []string) {
	filtered := make([]interface{}, 0, len(groups))
	var removed []string
	for _, raw := range groups {
		group, ok := raw.(map[string]interface{})
		if !ok {
			filtered = append(filtered, raw)
			continue
		}
		entries, _ := group["hooks"].([]interface{})
		kept := make([]interface{}, 0, len(entries))
		for _, e := range entries {
			entry, ok := e.(map[string]interface{})
			if !ok {
				kept = append(kept, e)
				continue
			}
			cmd, _ := entry["command"].(string)
			if isManaged(cmd) {
				removed = append(removed, cmd)
				continue
			}
			kept = append(kept, e)
		}
		if len(kept) == 0 {
			continue
		}
		group["hooks"] = kept
		filtered = append(filtered, group)
	}
	return filtered, removed
}

// isManagedClaudeHook reports whether a hook command is one amikalog owns and
// may freely replace: its own capture entry, or the deprecated
// `amika sessions capture --source claude` hook it supersedes (left behind by
// the removed `amika sessions capture-init`).
func isManagedClaudeHook(cmd string) bool {
	return looksLikeAmikalogClaudeHook(cmd) || looksLikeLegacyAmikaCaptureHook(cmd)
}

// looksLikeAmikalogClaudeHook reports whether cmd invokes an amikalog
// executable with the Claude capture argv. The executable path may be quoted
// and may differ from the current binary's path; we identify by argv shape so
// renames don't strand stale entries.
func looksLikeAmikalogClaudeHook(cmd string) bool {
	return matchesHookArgv(cmd, binaryName, []string{"hook", "--source", "claude"})
}

// looksLikeLegacyAmikaCaptureHook reports whether cmd is the deprecated
// `amika sessions capture --source claude` Stop hook that amikalog replaces.
func looksLikeLegacyAmikaCaptureHook(cmd string) bool {
	return matchesHookArgv(cmd, "amika", []string{"sessions", "capture", "--source", "claude"})
}

// isManagedCodexHook reports whether a Codex hooks.json command is amikalog's
// own capture entry (and thus may be replaced/removed).
func isManagedCodexHook(cmd string) bool {
	return matchesHookArgv(cmd, binaryName, []string{"hook", "--source", "codex"})
}

// matchesHookArgv reports whether cmd is a single command whose argv[0] has the
// given basename and whose remaining args equal wantTail exactly.
func matchesHookArgv(cmd, wantBase string, wantTail []string) bool {
	argv := splitShellArgv(cmd)
	if len(argv) != len(wantTail)+1 {
		return false
	}
	for i, w := range wantTail {
		if argv[i+1] != w {
			return false
		}
	}
	return filepath.Base(argv[0]) == wantBase
}

// splitShellArgv tokenizes a string the way /bin/sh would for the subset of
// quoting shellQuote produces: single-quoted regions plus the '\” escape for
// literal apostrophes. Sufficient to recognize commands we wrote and common
// hand-edited variants.
func splitShellArgv(s string) []string {
	var out []string
	var cur []byte
	inSingle := false
	started := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inSingle {
			if c == '\'' {
				inSingle = false
				continue
			}
			cur = append(cur, c)
			started = true
			continue
		}
		if c == '\\' && i+1 < len(s) {
			cur = append(cur, s[i+1])
			started = true
			i++
			continue
		}
		if c == '\'' {
			inSingle = true
			started = true
			continue
		}
		if c == ' ' || c == '\t' {
			if started {
				out = append(out, string(cur))
				cur = cur[:0]
				started = false
			}
			continue
		}
		cur = append(cur, c)
		started = true
	}
	if started {
		out = append(out, string(cur))
	}
	return out
}

func readJSONObject(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]interface{}{}, nil
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	if out == nil {
		out = map[string]interface{}{}
	}
	return out, nil
}

func writeJSONObject(path string, obj map[string]interface{}) error {
	encoded, err := json.MarshalIndent(obj, "", "  ")
	if err != nil {
		return fmt.Errorf("encoding %s: %w", path, err)
	}
	encoded = append(encoded, '\n')
	return writeFileAtomic(path, encoded)
}

// removeCodexNotify deletes a top-level managed `notify` assignment (amikalog's
// own, or the deprecated amika sessions-capture program). A notify pointing
// elsewhere is left untouched. Returns whether the file changed.
func removeCodexNotify(path string) (bool, error) {
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		if errors.Is(readErr, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("reading %s: %w", path, readErr)
	}
	lines := splitLines(string(data))
	start, end, existing := findTopLevelNotify(lines)
	if start < 0 || !codexNotifyIsManaged(existing) {
		return false, nil
	}
	remaining := append([]string{}, lines[:start]...)
	remaining = append(remaining, lines[end+1:]...)
	out := strings.Join(remaining, "\n")
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	if err := writeFileAtomic(path, []byte(out)); err != nil {
		return false, err
	}
	return true, nil
}

func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("creating dir for %s: %w", path, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".amikalog-*")
	if err != nil {
		return fmt.Errorf("creating tempfile for %s: %w", path, err)
	}
	tmpPath := tmp.Name()
	defer func() {
		if tmpPath != "" {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("writing %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing tempfile for %s: %w", path, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("renaming tempfile to %s: %w", path, err)
	}
	tmpPath = ""
	return nil
}

// splitLines splits on '\n' while dropping a single trailing empty element so a
// final newline survives round-tripping without growing on each rewrite.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	out := strings.Split(s, "\n")
	if len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}

// findTopLevelNotify locates a top-level `notify = ...` assignment, ignoring any
// that appears after the first [section] header. Returns the line range (start,
// end inclusive) and the trimmed right-hand side, or (-1, -1, "") when none.
// Multi-line inline arrays are joined so codexNotifyIsAmika can parse them.
func findTopLevelNotify(lines []string) (int, int, string) {
	for i, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if strings.HasPrefix(trimmed, "[") {
			return -1, -1, ""
		}
		if !strings.HasPrefix(trimmed, "notify") {
			continue
		}
		rest := strings.TrimPrefix(trimmed, "notify")
		rest = strings.TrimLeft(rest, " \t")
		if !strings.HasPrefix(rest, "=") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(rest, "="))
		end := i
		if strings.HasPrefix(value, "[") && !tomlValueParses(value) {
			var buf strings.Builder
			buf.WriteString(value)
			for j := i + 1; j < len(lines); j++ {
				buf.WriteByte('\n')
				buf.WriteString(lines[j])
				end = j
				if tomlValueParses(buf.String()) {
					break
				}
			}
			value = buf.String()
		}
		return i, end, value
	}
	return -1, -1, ""
}

// tomlValueParses reports whether value is a complete, parseable TOML value.
func tomlValueParses(value string) bool {
	var holder map[string]interface{}
	_, err := toml.Decode("x = "+value+"\n", &holder)
	return err == nil
}

// codexNotifyIsManaged reports whether a notify value is one amikalog owns and
// may freely replace: its own program, or the deprecated amika sessions-capture
// program it supersedes.
func codexNotifyIsManaged(value string) bool {
	return codexNotifyIsAmika(value) || codexNotifyIsLegacyAmika(value)
}

// codexNotifyIsLegacyAmika reports whether a notify value is the deprecated
// `amika sessions capture --source codex` program left behind by the removed
// `amika sessions capture-init`.
func codexNotifyIsLegacyAmika(value string) bool {
	v := strings.TrimSpace(value)
	if !strings.HasPrefix(v, "[") {
		return false
	}
	var argv []string
	if err := tomlArrayDecode(v, &argv); err != nil {
		return false
	}
	if len(argv) < 3 {
		return false
	}
	return filepath.Base(argv[0]) == "amika" && argv[1] == "sessions" && argv[2] == "capture"
}

// codexNotifyIsAmika reports whether a notify value invokes the amikalog binary.
// Only array-form values whose argv[0] has basename "amikalog" count as ours, so
// third-party notify programs are never overwritten. The basename check (vs a
// suffix check) keeps "/usr/bin/notamikalog" from matching.
func codexNotifyIsAmika(value string) bool {
	v := strings.TrimSpace(value)
	if !strings.HasPrefix(v, "[") {
		return false
	}
	var argv []string
	if err := tomlArrayDecode(v, &argv); err != nil {
		return false
	}
	if len(argv) == 0 {
		return false
	}
	return filepath.Base(argv[0]) == binaryName
}

// tomlArrayDecode decodes a TOML inline array of strings into argv.
func tomlArrayDecode(value string, dst *[]string) error {
	doc := "x = " + value + "\n"
	var holder struct {
		X []string `toml:"x"`
	}
	if _, err := toml.Decode(doc, &holder); err != nil {
		return err
	}
	*dst = holder.X
	return nil
}

// shellQuote wraps s in single quotes if it contains characters /bin/sh would
// interpret. Hook commands are passed through a shell, so paths with spaces need
// quoting.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			continue
		}
		switch r {
		case '_', '-', '/', '.', ':', ',', '=', '+':
			continue
		}
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}
