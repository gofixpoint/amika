package sessioncapture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestInit_FreshClaudeAndCodex(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	rep, err := Init(home, HookCommand{Exe: "/usr/local/bin/amika"})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if !rep.ClaudeUpdated || !rep.CodexUpdated {
		t.Fatalf("expected both to be updated, got %+v", rep)
	}

	settings := readClaudeSettings(t, rep.ClaudeSettingsPath)
	wantCmd := "/usr/local/bin/amika sessions capture --source claude"
	if !claudeHasHook(settings, wantCmd) {
		t.Errorf("Claude settings missing Stop hook with command %q: %#v", wantCmd, settings)
	}

	codex, err := os.ReadFile(rep.CodexConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	want := `notify = ["/usr/local/bin/amika", "sessions", "capture", "--source", "codex"]`
	if !strings.Contains(string(codex), want) {
		t.Errorf("codex config missing %q, got:\n%s", want, codex)
	}
}

func TestInit_Idempotent(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	cmd := HookCommand{Exe: "/usr/local/bin/amika"}
	if _, err := Init(home, cmd); err != nil {
		t.Fatal(err)
	}
	rep, err := Init(home, cmd)
	if err != nil {
		t.Fatal(err)
	}
	if rep.ClaudeUpdated || rep.CodexUpdated {
		t.Errorf("expected no changes on second run, got %+v", rep)
	}
}

func TestInit_PreservesExistingClaudeKeys(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := map[string]interface{}{
		"theme": "dark",
		"hooks": map[string]interface{}{
			"PreToolUse": []interface{}{
				map[string]interface{}{"hooks": []interface{}{map[string]interface{}{"type": "command", "command": "other-tool"}}},
			},
		},
	}
	raw, _ := json.Marshal(existing)
	if err := os.WriteFile(settingsPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Init(home, HookCommand{Exe: "amika"}); err != nil {
		t.Fatal(err)
	}
	got := readClaudeSettings(t, settingsPath)
	if v, _ := got["theme"].(string); v != "dark" {
		t.Errorf("theme key lost: %#v", got)
	}
	hooks, _ := got["hooks"].(map[string]interface{})
	if _, ok := hooks["PreToolUse"]; !ok {
		t.Errorf("PreToolUse hooks lost: %#v", hooks)
	}
	if !claudeHasHook(got, "amika sessions capture --source claude") {
		t.Errorf("Stop hook not added: %#v", hooks)
	}
}

func TestInit_PreservesCodexConflict(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	cfg := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	contents := `model = "gpt-5"
notify = ["my-tool", "--watch"]

[projects."/x"]
trust_level = "trusted"
`
	if err := os.WriteFile(cfg, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Init(home, HookCommand{Exe: "/usr/local/bin/amika"})
	if err != nil {
		t.Fatal(err)
	}
	if rep.CodexUpdated {
		t.Errorf("expected to leave conflicting notify alone, got updated=true")
	}
	if rep.CodexConflict == "" {
		t.Errorf("expected CodexConflict to be reported")
	}
	got, _ := os.ReadFile(cfg)
	if string(got) != contents {
		t.Errorf("config was modified despite conflict:\n%s", got)
	}
}

func TestInit_UpdatesExistingAmikaNotify(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	cfg := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	contents := `model = "gpt-5"
notify = ["/old/path/amika", "sessions", "capture", "--source", "codex"]
`
	if err := os.WriteFile(cfg, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Init(home, HookCommand{Exe: "/new/path/amika"})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.CodexUpdated {
		t.Errorf("expected update when path changed, got %+v", rep)
	}
	got, _ := os.ReadFile(cfg)
	if !strings.Contains(string(got), `"/new/path/amika"`) {
		t.Errorf("notify not updated: %s", got)
	}
	if strings.Contains(string(got), `"/old/path/amika"`) {
		t.Errorf("old notify path still present: %s", got)
	}
}

func TestInit_TreatsLookalikeNotifyAsConflict(t *testing.T) {
	useCodexFallback(t)
	for _, name := range []string{"notamika", "my-amika", "amikatool"} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			cfg := filepath.Join(home, ".codex", "config.toml")
			if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
				t.Fatal(err)
			}
			contents := `notify = ["/usr/local/bin/` + name + `", "--watch"]` + "\n"
			if err := os.WriteFile(cfg, []byte(contents), 0o644); err != nil {
				t.Fatal(err)
			}

			rep, err := Init(home, HookCommand{Exe: "/usr/local/bin/amika"})
			if err != nil {
				t.Fatal(err)
			}
			if rep.CodexUpdated {
				t.Errorf("expected lookalike %q to be treated as conflict, not replaced", name)
			}
			if rep.CodexConflict == "" {
				t.Errorf("expected CodexConflict to be reported for lookalike %q", name)
			}
			got, _ := os.ReadFile(cfg)
			if string(got) != contents {
				t.Errorf("notify for lookalike %q was modified:\n%s", name, got)
			}
		})
	}
}

func TestInit_HonorsCODEX_HOME(t *testing.T) {
	home := t.TempDir()
	codexHome := t.TempDir()
	t.Setenv("CODEX_HOME", codexHome)

	rep, err := Init(home, HookCommand{Exe: "/usr/local/bin/amika"})
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	if rep.CodexConfigPath != filepath.Join(codexHome, "config.toml") {
		t.Errorf("CodexConfigPath = %q, want under CODEX_HOME (%q)", rep.CodexConfigPath, codexHome)
	}
	if _, err := os.Stat(filepath.Join(codexHome, "config.toml")); err != nil {
		t.Errorf("expected config.toml under CODEX_HOME: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "config.toml")); !os.IsNotExist(err) {
		t.Errorf("config.toml should not be written to ~/.codex when CODEX_HOME is set: %v", err)
	}
}

func TestInit_InsertsBeforeFirstSection(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	cfg := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	contents := `model = "gpt-5"

[projects."/x"]
trust_level = "trusted"
`
	if err := os.WriteFile(cfg, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Init(home, HookCommand{Exe: "amika"}); err != nil {
		t.Fatal(err)
	}

	got, _ := os.ReadFile(cfg)
	notifyIdx := strings.Index(string(got), "notify =")
	sectionIdx := strings.Index(string(got), "[projects")
	if notifyIdx < 0 || sectionIdx < 0 {
		t.Fatalf("missing expected content: %s", got)
	}
	if notifyIdx >= sectionIdx {
		t.Errorf("notify not inserted before [projects] section:\n%s", got)
	}
}

func TestInit_UpdatesStaleClaudeHookPath(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := map[string]interface{}{
		"hooks": map[string]interface{}{
			"Stop": []interface{}{
				map[string]interface{}{
					"hooks": []interface{}{
						map[string]interface{}{"type": "command", "command": "/old/path/amika sessions capture --source claude"},
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(stale)
	if err := os.WriteFile(settingsPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	rep, err := Init(home, HookCommand{Exe: "/new/path/amika"})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.ClaudeUpdated {
		t.Errorf("expected ClaudeUpdated=true when binary path changed, got %+v", rep)
	}

	settings := readClaudeSettings(t, settingsPath)
	stopCommands := claudeStopCommands(settings)
	if len(stopCommands) != 1 {
		t.Fatalf("expected exactly one Stop command after update, got %v", stopCommands)
	}
	if stopCommands[0] != "/new/path/amika sessions capture --source claude" {
		t.Errorf("Stop command not updated: %v", stopCommands)
	}
	for _, c := range stopCommands {
		if strings.Contains(c, "/old/path/amika") {
			t.Errorf("stale path still present: %v", stopCommands)
		}
	}
}

func TestInit_PreservesNonAmikaStopHooks(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := map[string]interface{}{
		"hooks": map[string]interface{}{
			"Stop": []interface{}{
				map[string]interface{}{
					"hooks": []interface{}{
						map[string]interface{}{"type": "command", "command": "other-tool --watch"},
						map[string]interface{}{"type": "command", "command": "/old/amika sessions capture --source claude"},
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(existing)
	if err := os.WriteFile(settingsPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Init(home, HookCommand{Exe: "/new/amika"}); err != nil {
		t.Fatal(err)
	}

	settings := readClaudeSettings(t, settingsPath)
	stopCommands := claudeStopCommands(settings)
	sort.Strings(stopCommands)
	want := []string{"/new/amika sessions capture --source claude", "other-tool --watch"}
	if !reflect.DeepEqual(stopCommands, want) {
		t.Errorf("Stop commands = %v, want %v", stopCommands, want)
	}
}

func TestInit_CollapsesDuplicateAmikaHooks(t *testing.T) {
	useCodexFallback(t)
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	existing := map[string]interface{}{
		"hooks": map[string]interface{}{
			"Stop": []interface{}{
				map[string]interface{}{"hooks": []interface{}{
					map[string]interface{}{"type": "command", "command": "/a/amika sessions capture --source claude"},
				}},
				map[string]interface{}{"hooks": []interface{}{
					map[string]interface{}{"type": "command", "command": "/b/amika sessions capture --source claude"},
				}},
			},
		},
	}
	raw, _ := json.Marshal(existing)
	if err := os.WriteFile(settingsPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Init(home, HookCommand{Exe: "/c/amika"}); err != nil {
		t.Fatal(err)
	}

	settings := readClaudeSettings(t, settingsPath)
	if got := claudeStopCommands(settings); len(got) != 1 || got[0] != "/c/amika sessions capture --source claude" {
		t.Errorf("expected one collapsed hook pointing at /c/amika, got %v", got)
	}
}

func TestLooksLikeClaudeAmikaHook(t *testing.T) {
	cases := map[string]bool{
		"/usr/local/bin/amika sessions capture --source claude":     true,
		"amika sessions capture --source claude":                    true,
		"./dist/amika sessions capture --source claude":             true,
		"'/path with space/amika' sessions capture --source claude": true,
		"/usr/local/bin/not-amika sessions capture --source claude": false,
		"other-tool --watch":                               false,
		"amika sessions capture --source codex":            false,
		"amika sessions capture --source claude --verbose": false,
		"": false,
	}
	for in, want := range cases {
		if got := looksLikeClaudeAmikaHook(in); got != want {
			t.Errorf("looksLikeClaudeAmikaHook(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"/usr/local/bin/amika":   "/usr/local/bin/amika",
		"/path with space/amika": "'/path with space/amika'",
		"weird'name":             `'weird'\''name'`,
		"":                       "''",
		"plain-thing_1.2":        "plain-thing_1.2",
	}
	for in, want := range cases {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %q, want %q", in, got, want)
		}
	}
}

func readClaudeSettings(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading claude settings: %v", err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decoding claude settings: %v", err)
	}
	return out
}

func claudeHasHook(settings map[string]interface{}, command string) bool {
	for _, c := range claudeStopCommands(settings) {
		if c == command {
			return true
		}
	}
	return false
}

func claudeStopCommands(settings map[string]interface{}) []string {
	hooks, _ := settings["hooks"].(map[string]interface{})
	stop, _ := hooks["Stop"].([]interface{})
	var out []string
	for _, raw := range stop {
		group, _ := raw.(map[string]interface{})
		entries, _ := group["hooks"].([]interface{})
		for _, e := range entries {
			entry, _ := e.(map[string]interface{})
			if cmd, ok := entry["command"].(string); ok {
				out = append(out, cmd)
			}
		}
	}
	return out
}
