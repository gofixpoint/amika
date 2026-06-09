package eventlog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testCommand() HookCommand {
	return HookCommand{Exe: "/opt/bin/amikalog"}
}

// readClaudeHooks returns the parsed "hooks" object from a settings file.
func readClaudeHooks(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	hooks, _ := settings["hooks"].(map[string]interface{})
	return hooks
}

func TestInit_InstallsEveryClaudeEvent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	rep, err := Init(home, testCommand())
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if !rep.ClaudeUpdated {
		t.Error("ClaudeUpdated = false, want true on first install")
	}

	hooks := readClaudeHooks(t, rep.ClaudeSettingsPath)
	wantCmd := testCommand().ClaudeCommand()
	for _, event := range claudeHookEvents {
		groups, ok := hooks[event].([]interface{})
		if !ok || len(groups) == 0 {
			t.Fatalf("event %s missing from settings", event)
		}
		group := groups[len(groups)-1].(map[string]interface{})
		if usesMatcher(event) {
			if group["matcher"] != "*" {
				t.Errorf("event %s matcher = %v, want *", event, group["matcher"])
			}
		} else if _, has := group["matcher"]; has {
			t.Errorf("event %s should not carry a matcher", event)
		}
		entries := group["hooks"].([]interface{})
		entry := entries[0].(map[string]interface{})
		if entry["command"] != wantCmd {
			t.Errorf("event %s command = %v, want %q", event, entry["command"], wantCmd)
		}
	}
}

func TestInit_Idempotent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	if _, err := Init(home, testCommand()); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	configPath := filepath.Join(CodexHome(home), "config.toml")
	before := readFile(t, settingsPath)
	beforeCfg := readFile(t, configPath)

	rep, err := Init(home, testCommand())
	if err != nil {
		t.Fatal(err)
	}
	if rep.ClaudeUpdated {
		t.Error("ClaudeUpdated = true on re-run, want false")
	}
	if rep.CodexUpdated {
		t.Error("CodexUpdated = true on re-run, want false")
	}
	if after := readFile(t, settingsPath); after != before {
		t.Errorf("settings changed on re-run:\nbefore=%s\nafter=%s", before, after)
	}
	if after := readFile(t, configPath); after != beforeCfg {
		t.Errorf("codex config changed on re-run:\nbefore=%s\nafter=%s", beforeCfg, after)
	}
}

func TestInit_PreservesUnrelatedSettings(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	seed := `{
  "model": "opus",
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "/usr/bin/other-tool"}]}]
  }
}`
	writeFile(t, settingsPath, seed)

	if _, err := Init(home, testCommand()); err != nil {
		t.Fatal(err)
	}

	data := readFile(t, settingsPath)
	if !strings.Contains(data, `"model": "opus"`) {
		t.Error("unrelated top-level key was dropped")
	}
	if !strings.Contains(data, "/usr/bin/other-tool") {
		t.Error("unrelated Stop hook was dropped")
	}
	if !strings.Contains(data, testCommand().ClaudeCommand()) {
		t.Error("amikalog hook was not added")
	}
}

func TestInit_ReplacesStaleAmikalogExe(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	// Install with an old exe path, then re-install with a new one.
	if _, err := Init(home, HookCommand{Exe: "/old/path/amikalog"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Init(home, HookCommand{Exe: "/new/path/amikalog"}); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	data := readFile(t, settingsPath)
	if strings.Contains(data, "/old/path/amikalog") {
		t.Error("stale amikalog hook was not replaced")
	}
	if strings.Count(data, "/new/path/amikalog hook --source claude") != len(claudeHookEvents) {
		t.Errorf("expected exactly one new hook per event (%d), got %d", len(claudeHookEvents),
			strings.Count(data, "/new/path/amikalog hook --source claude"))
	}
}

func TestInit_CodexNotify(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	rep, err := Init(home, testCommand())
	if err != nil {
		t.Fatal(err)
	}
	cfg := readFile(t, rep.CodexConfigPath)
	if !strings.Contains(cfg, `notify = ["/opt/bin/amikalog", "hook", "--source", "codex"]`) {
		t.Errorf("codex config missing amikalog notify:\n%s", cfg)
	}
}

func TestInit_CodexNotifyConflictLeftAlone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	configPath := filepath.Join(CodexHome(home), "config.toml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, configPath, "notify = [\"/usr/bin/other\"]\n")

	rep, err := Init(home, testCommand())
	if err != nil {
		t.Fatal(err)
	}
	if rep.CodexConflict == "" {
		t.Error("expected CodexConflict to be reported")
	}
	if rep.CodexUpdated {
		t.Error("CodexUpdated = true, want false when leaving a conflicting notify alone")
	}
	if cfg := readFile(t, configPath); !strings.Contains(cfg, "/usr/bin/other") {
		t.Errorf("conflicting notify was overwritten:\n%s", cfg)
	}
}

func TestUninstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	if _, err := Init(home, testCommand()); err != nil {
		t.Fatal(err)
	}

	rep, err := Uninstall(home)
	if err != nil {
		t.Fatal(err)
	}
	if !rep.ClaudeUpdated {
		t.Error("ClaudeUpdated = false, want true (hooks should be removed)")
	}
	if !rep.CodexUpdated {
		t.Error("CodexUpdated = false, want true (notify should be removed)")
	}

	if hooks := readClaudeHooks(t, rep.ClaudeSettingsPath); len(hooks) != 0 {
		t.Errorf("hooks remain after uninstall: %v", hooks)
	}
	if cfg := readFile(t, rep.CodexConfigPath); strings.Contains(cfg, "amikalog") {
		t.Errorf("notify remains after uninstall:\n%s", cfg)
	}

	// Second uninstall is a no-op.
	rep2, err := Uninstall(home)
	if err != nil {
		t.Fatal(err)
	}
	if rep2.ClaudeUpdated || rep2.CodexUpdated {
		t.Errorf("second uninstall reported changes: %+v", rep2)
	}
}

func TestUninstall_LeavesUnrelatedHooks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, settingsPath, `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/usr/bin/other-tool"}]}]}}`)
	if _, err := Init(home, testCommand()); err != nil {
		t.Fatal(err)
	}
	if _, err := Uninstall(home); err != nil {
		t.Fatal(err)
	}
	data := readFile(t, settingsPath)
	if !strings.Contains(data, "/usr/bin/other-tool") {
		t.Errorf("unrelated hook removed by uninstall:\n%s", data)
	}
	if strings.Contains(data, "amikalog") {
		t.Errorf("amikalog hook survived uninstall:\n%s", data)
	}
}

func TestInit_MigratesLegacyClaudeCaptureHook(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	// Stale Stop hook left by the removed `amika sessions capture-init`.
	writeFile(t, settingsPath, `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/usr/local/bin/amika sessions capture --source claude"}]}]}}`)

	if _, err := Init(home, testCommand()); err != nil {
		t.Fatal(err)
	}
	data := readFile(t, settingsPath)
	if strings.Contains(data, "sessions capture --source claude") {
		t.Errorf("legacy amika capture hook was not migrated away:\n%s", data)
	}
	if strings.Count(data, testCommand().ClaudeCommand()) != len(claudeHookEvents) {
		t.Errorf("expected one amikalog hook per event after migration:\n%s", data)
	}
}

func TestInit_MigratesLegacyCodexNotify(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	configPath := filepath.Join(CodexHome(home), "config.toml")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, configPath, `notify = ["/usr/local/bin/amika", "sessions", "capture", "--source", "codex"]`+"\n")

	rep, err := Init(home, testCommand())
	if err != nil {
		t.Fatal(err)
	}
	if rep.CodexConflict != "" {
		t.Errorf("legacy amika notify reported as conflict: %q", rep.CodexConflict)
	}
	if !rep.CodexUpdated {
		t.Error("CodexUpdated = false, want true when migrating legacy notify")
	}
	cfg := readFile(t, configPath)
	if strings.Contains(cfg, "sessions") {
		t.Errorf("legacy amika notify was not migrated:\n%s", cfg)
	}
	if !strings.Contains(cfg, `notify = ["/opt/bin/amikalog", "hook", "--source", "codex"]`) {
		t.Errorf("amikalog notify not installed after migration:\n%s", cfg)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}
