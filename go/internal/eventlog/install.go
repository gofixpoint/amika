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

// claudeHookEvents is every Claude Code hook event amikalog registers for. The
// same command handles them all; it reads the specific event from the payload's
// hook_event_name field.
var claudeHookEvents = []string{
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Notification",
	"Stop",
	"SubagentStop",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
}

// usesMatcher reports whether a Claude hook event groups its hooks by a tool
// matcher (PreToolUse/PostToolUse) versus firing unconditionally.
func usesMatcher(event string) bool {
	return event == "PreToolUse" || event == "PostToolUse"
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

// CodexNotify returns the program-and-args list Codex's `notify` should run.
func (h HookCommand) CodexNotify() []string {
	return []string{h.Exe, "hook", "--source", "codex"}
}

// InitReport summarizes what Init (or Uninstall) did so the CLI can print
// useful feedback.
type InitReport struct {
	ClaudeSettingsPath string
	ClaudeUpdated      bool // false when nothing changed
	CodexConfigPath    string
	CodexUpdated       bool   // false when nothing changed
	CodexConflict      string // non-empty when notify pointed elsewhere; left alone
}

// Init wires amikalog hooks into Claude Code's settings (one per hook event)
// and a notify program into Codex's config under homeDir. The Codex side honors
// $CODEX_HOME (see CodexHome). Init is idempotent: running it twice is a no-op.
func Init(homeDir string, cmd HookCommand) (InitReport, error) {
	rep := InitReport{
		ClaudeSettingsPath: filepath.Join(homeDir, ".claude", "settings.json"),
		CodexConfigPath:    filepath.Join(CodexHome(homeDir), "config.toml"),
	}

	claudeUpdated, err := ensureClaudeHooks(rep.ClaudeSettingsPath, cmd.ClaudeCommand())
	if err != nil {
		return rep, err
	}
	rep.ClaudeUpdated = claudeUpdated

	codexUpdated, conflict, err := ensureCodexNotify(rep.CodexConfigPath, cmd.CodexNotify())
	if err != nil {
		return rep, err
	}
	rep.CodexUpdated = codexUpdated
	rep.CodexConflict = conflict

	return rep, nil
}

// Uninstall removes amikalog hooks from Claude Code's settings and the Codex
// notify program, leaving unrelated entries untouched. Its InitReport reuses
// the *Updated fields to report whether anything was removed.
func Uninstall(homeDir string) (InitReport, error) {
	rep := InitReport{
		ClaudeSettingsPath: filepath.Join(homeDir, ".claude", "settings.json"),
		CodexConfigPath:    filepath.Join(CodexHome(homeDir), "config.toml"),
	}

	claudeUpdated, err := removeClaudeHooks(rep.ClaudeSettingsPath)
	if err != nil {
		return rep, err
	}
	rep.ClaudeUpdated = claudeUpdated

	codexUpdated, err := removeCodexNotify(rep.CodexConfigPath)
	if err != nil {
		return rep, err
	}
	rep.CodexUpdated = codexUpdated

	return rep, nil
}

// ensureClaudeHooks reads the settings file, makes every event in
// claudeHookEvents run command exactly once, and writes the file back. Prior
// amikalog entries are stripped first (recognized by argv shape, not exact
// string) so re-running from a different executable path replaces stale entries
// rather than appending duplicates. Returns whether the file changed.
//
// The Claude hooks schema is documented at
// https://docs.claude.com/en/docs/claude-code/hooks. It is modeled as nested
// map[string]interface{} so unrelated keys round-trip unchanged.
func ensureClaudeHooks(path, command string) (bool, error) {
	settings, err := readJSONObject(path)
	if err != nil {
		return false, err
	}
	before, err := json.Marshal(settings)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}

	hooks, _ := settings["hooks"].(map[string]interface{})
	if hooks == nil {
		hooks = map[string]interface{}{}
	}
	for _, event := range claudeHookEvents {
		groups, _ := hooks[event].([]interface{})
		filtered, _ := stripAmikalogHooks(groups)
		group := map[string]interface{}{
			"hooks": []interface{}{
				map[string]interface{}{"type": "command", "command": command},
			},
		}
		if usesMatcher(event) {
			group["matcher"] = "*"
		}
		hooks[event] = append(filtered, group)
	}
	settings["hooks"] = hooks

	after, err := json.Marshal(settings)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}
	if bytes.Equal(before, after) {
		return false, nil
	}
	return true, writeJSONObject(path, settings)
}

// removeClaudeHooks strips every amikalog entry from all hook events, dropping
// events (and the hooks object) that become empty. Returns whether anything
// changed.
func removeClaudeHooks(path string) (bool, error) {
	settings, err := readJSONObject(path)
	if err != nil {
		return false, err
	}
	hooks, _ := settings["hooks"].(map[string]interface{})
	if hooks == nil {
		return false, nil
	}
	before, err := json.Marshal(settings)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}

	for _, event := range claudeHookEvents {
		groups, _ := hooks[event].([]interface{})
		if groups == nil {
			continue
		}
		filtered, _ := stripAmikalogHooks(groups)
		if len(filtered) == 0 {
			delete(hooks, event)
		} else {
			hooks[event] = filtered
		}
	}
	if len(hooks) == 0 {
		delete(settings, "hooks")
	} else {
		settings["hooks"] = hooks
	}

	after, err := json.Marshal(settings)
	if err != nil {
		return false, fmt.Errorf("encoding %s: %w", path, err)
	}
	if bytes.Equal(before, after) {
		return false, nil
	}
	return true, writeJSONObject(path, settings)
}

// stripAmikalogHooks returns the input hook groups with every amikalog-installed
// entry removed (groups that become empty are dropped), plus the raw command
// strings of the entries that were removed.
func stripAmikalogHooks(groups []interface{}) ([]interface{}, []string) {
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
			if isManagedClaudeHook(cmd) {
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

// ensureCodexNotify ensures Codex's top-level `notify` array invokes argv,
// editing line-wise so comments and formatting survive. Returns:
//   - updated: true when the file was modified
//   - conflict: a description of an existing non-amikalog notify value, in which
//     case no changes are made
func ensureCodexNotify(path string, argv []string) (updated bool, conflict string, err error) {
	want := formatCodexNotify(argv)

	data, readErr := os.ReadFile(path)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return false, "", fmt.Errorf("reading %s: %w", path, readErr)
	}

	lines := splitLines(string(data))
	start, end, existing := findTopLevelNotify(lines)

	if start >= 0 {
		if existing == want {
			return false, "", nil
		}
		if !codexNotifyIsManaged(existing) {
			return false, existing, nil
		}
		replaced := append([]string{}, lines[:start]...)
		replaced = append(replaced, "notify = "+want)
		lines = append(replaced, lines[end+1:]...)
	} else {
		lines = insertCodexNotify(lines, "notify = "+want)
	}

	out := strings.Join(lines, "\n")
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	if err := writeFileAtomic(path, []byte(out)); err != nil {
		return false, "", err
	}
	return true, "", nil
}

// removeCodexNotify deletes a top-level amikalog `notify` assignment. It leaves
// a notify pointing elsewhere untouched. Returns whether the file changed.
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

func formatCodexNotify(argv []string) string {
	parts := make([]string, len(argv))
	for i, a := range argv {
		b, _ := json.Marshal(a) // JSON strings are valid TOML basic strings
		parts[i] = string(b)
	}
	return "[" + strings.Join(parts, ", ") + "]"
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

func insertCodexNotify(lines []string, assignment string) []string {
	// Insert before the first [section] header so the assignment is top-level.
	for i, raw := range lines {
		if strings.HasPrefix(strings.TrimSpace(raw), "[") {
			head := append([]string{}, lines[:i]...)
			if len(head) > 0 && head[len(head)-1] != "" {
				head = append(head, "")
			}
			head = append(head, assignment, "")
			return append(head, lines[i:]...)
		}
	}
	// No section headers — append, separating from existing content.
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}
	return append(lines, assignment)
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
