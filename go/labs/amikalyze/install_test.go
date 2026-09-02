package amikalyze

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallHooks_SelectedAgentsAndIdempotency(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	command := HookCommand{Exe: "/opt/Amika Tools/amikalyze"}

	reports, err := InstallHooks(home, []Agent{AgentClaude}, command)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || !reports[0].Updated {
		t.Fatalf("reports = %+v", reports)
	}
	settings := readTestFile(t, filepath.Join(home, ".claude", "settings.json"))
	if !strings.Contains(settings, "Edit|Write") || !strings.Contains(settings, "hook --source claude") {
		t.Fatalf("Claude settings missing hook:\n%s", settings)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "hooks.json")); !os.IsNotExist(err) {
		t.Fatalf("Codex hooks were unexpectedly installed: %v", err)
	}

	reports, err = InstallHooks(home, []Agent{AgentClaude}, command)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].Updated {
		t.Fatalf("second install reports = %+v, want unchanged", reports)
	}
}

func TestInstallHooks_PreservesUnrelatedAndReplacesStale(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", "")
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	writeTestFile(t, settingsPath, `{
  "model": "opus",
  "hooks": {
    "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/bin/other"}]}]
  }
}`)
	if _, err := InstallHooks(home, []Agent{AgentClaude}, HookCommand{Exe: "/old/amikalyze"}); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallHooks(home, []Agent{AgentClaude}, HookCommand{Exe: "/new/amikalyze"}); err != nil {
		t.Fatal(err)
	}
	settings := readTestFile(t, settingsPath)
	for _, want := range []string{`"model": "opus"`, "/usr/bin/other", "/new/amikalyze"} {
		if !strings.Contains(settings, want) {
			t.Errorf("settings missing %q:\n%s", want, settings)
		}
	}
	if strings.Contains(settings, "/old/amikalyze") {
		t.Errorf("stale hook remains:\n%s", settings)
	}
}

func TestInstallAndUninstallCodexHooks(t *testing.T) {
	home := t.TempDir()
	codexHome := filepath.Join(t.TempDir(), "custom-codex")
	t.Setenv("CODEX_HOME", codexHome)
	reports, err := InstallHooks(home, []Agent{AgentCodex}, HookCommand{Exe: "/opt/amikalyze"})
	if err != nil {
		t.Fatal(err)
	}
	if reports[0].Path != filepath.Join(codexHome, "hooks.json") {
		t.Fatalf("Codex hook path = %q", reports[0].Path)
	}
	data := readTestFile(t, reports[0].Path)
	if !strings.Contains(data, "^apply_patch$") || !strings.Contains(data, "hook --source codex") {
		t.Fatalf("Codex hooks missing entry:\n%s", data)
	}

	reports, err = UninstallHooks(home, []Agent{AgentCodex})
	if err != nil {
		t.Fatal(err)
	}
	if !reports[0].Updated {
		t.Fatal("uninstall reported no update")
	}
	var object map[string]interface{}
	if err := json.Unmarshal([]byte(readTestFile(t, reports[0].Path)), &object); err != nil {
		t.Fatal(err)
	}
	if _, exists := object["hooks"]; exists {
		t.Fatalf("hooks remain after uninstall: %+v", object)
	}
}

func readTestFile(t *testing.T, filename string) string {
	t.Helper()
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
