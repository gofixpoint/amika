package amikalyze

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEvaluateHook_Claude(t *testing.T) {
	root := initTestRepo(t)
	writeTestFile(t, filepath.Join(root, configName), `
[[freezes]]
label = "schema"
paths = ["schema/**"]
`)
	payload := fmt.Sprintf(`{
  "cwd": %q,
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {"file_path": %q, "content": "changed"}
}`, root, filepath.Join(root, "schema", "one.sql"))
	decision, err := EvaluateHook(SourceClaude, strings.NewReader(payload), Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Frozen() || !strings.Contains(decision.DenialReason(), `freeze "schema"`) {
		t.Fatalf("decision = %+v, reason = %q", decision, decision.DenialReason())
	}
}

func TestEvaluateHook_CodexMultiFileAndOverride(t *testing.T) {
	root := initTestRepo(t)
	writeTestFile(t, filepath.Join(root, configName), `
[[freezes]]
label = "schema"
paths = ["schema/**"]
`)
	patch := `*** Begin Patch
*** Update File: source.go
@@
-old
+new
*** Update File: schema/one.sql
@@
-old
+new
*** Move to: schema/two.sql
*** End Patch`
	payload := fmt.Sprintf(`{
  "cwd": %q,
  "hook_event_name": "PreToolUse",
  "tool_name": "apply_patch",
  "tool_input": {"command": %q}
}`, root, patch)
	decision, err := EvaluateHook(SourceCodex, strings.NewReader(payload), Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Frozen() {
		t.Fatal("multi-file patch was allowed despite frozen targets")
	}

	decision, err = EvaluateHook(SourceCodex, strings.NewReader(payload), Overrides{
		RepoRoot: root,
		Labels:   []string{"schema"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Frozen() {
		t.Fatalf("label override left frozen targets: %+v", decision.Decisions)
	}
}

func TestParsePatchTargets(t *testing.T) {
	patch := "*** Begin Patch\n*** Add File: one.txt\n+hello\n*** Update File: dir/two.txt\n*** Move to: dir/three.txt\n*** Delete File: four.txt\n*** End Patch"
	got, err := parsePatchTargets(patch)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"dir/three.txt", "dir/two.txt", "four.txt", "one.txt"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("targets = %v, want %v", got, want)
	}
}

func TestParsePatchTargets_RejectsMalformedPatch(t *testing.T) {
	for _, patch := range []string{"", "*** Begin Patch\n*** End Patch", "*** Begin Patch\n*** Add File: one"} {
		if _, err := parsePatchTargets(patch); err == nil {
			t.Errorf("parsePatchTargets(%q) succeeded, want error", patch)
		}
	}
}

func initTestRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	command := exec.Command("git", "init", "--quiet", root)
	command.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+filepath.Join(t.TempDir(), "none"))
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	return root
}
