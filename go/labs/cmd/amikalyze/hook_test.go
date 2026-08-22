package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestHookCommandBlocksAndExplainsFrozenClaudeEdit(t *testing.T) {
	root := initRepo(t)
	writeFile(t, filepath.Join(root, ".amikalyze.toml"), `
[[freezes]]
label = "schema"
paths = ["schema/**"]
`)
	payload := fmt.Sprintf(`{"cwd":%q,"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":%q}}`,
		root, filepath.Join(root, "schema", "one.sql"))
	output, err := runRootCommand(payload, "hook", "--source", "claude")
	if err != nil {
		t.Fatal(err)
	}
	var result preToolUseOutput
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("hook output is not JSON: %v\n%s", err, output)
	}
	decision := result.HookSpecificOutput
	if decision.PermissionDecision != "deny" || !strings.Contains(decision.PermissionDecisionReason, `freeze "schema"`) {
		t.Fatalf("hook decision = %+v", decision)
	}
}

func TestHookCommandAllowsUnfrozenEditWithoutOutput(t *testing.T) {
	root := initRepo(t)
	payload := fmt.Sprintf(`{"cwd":%q,"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":%q}}`,
		root, filepath.Join(root, "source.go"))
	output, err := runRootCommand(payload, "hook", "--source", "claude")
	if err != nil {
		t.Fatal(err)
	}
	if output != "" {
		t.Fatalf("allowed hook output = %q, want empty", output)
	}
}

func initRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	command := exec.Command("git", "init", "--quiet", root)
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+filepath.Join(t.TempDir(), "none"))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, output)
	}
	return root
}

func writeFile(t *testing.T, filename, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
