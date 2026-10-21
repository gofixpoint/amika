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

// Git reports the symlink-free repository root, so a cwd and target reached
// through a symlink must still be recognized as inside the repository. This
// also covers a target whose directory does not exist yet.
func TestEvaluateHook_SymlinkedRepoPath(t *testing.T) {
	root := initTestRepo(t)
	writeTestFile(t, filepath.Join(root, configName), `
[[freezes]]
label = "schema"
paths = ["schema/**"]
`)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		filepath.Join(link, "schema", "one.sql"),
		filepath.Join(link, "schema", "new", "two.sql"),
	} {
		payload := fmt.Sprintf(`{
  "cwd": %q,
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {"file_path": %q, "content": "changed"}
}`, link, target)
		decision, err := EvaluateHook(SourceClaude, strings.NewReader(payload), Overrides{})
		if err != nil {
			t.Fatal(err)
		}
		if !decision.Frozen() {
			t.Fatalf("edit to %s through a symlinked repo path was allowed", target)
		}
	}
}

// A cwd that is a symlink to a subdirectory of the repository, such as
// ~/frontend pointing at mono/frontend, still maps its targets into the
// repository.
func TestEvaluateHook_CWDSymlinkToRepoSubdirectory(t *testing.T) {
	root := initTestRepo(t)
	writeTestFile(t, filepath.Join(root, configName), `
[[freezes]]
label = "schema"
paths = ["sub/schema/**"]
`)
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(filepath.Join(root, "sub"), link); err != nil {
		t.Fatal(err)
	}
	payload := fmt.Sprintf(`{
  "cwd": %q,
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {"file_path": %q, "content": "changed"}
}`, link, filepath.Join("schema", "one.sql"))
	decision, err := EvaluateHook(SourceClaude, strings.NewReader(payload), Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Frozen() {
		t.Fatalf("edit through a cwd symlinked to a repository subdirectory was allowed: %+v", decision)
	}
}

// Targets are matched by the path the agent names, so a frozen path that is a
// symlink to a directory outside the repository stays frozen.
func TestEvaluateHook_FrozenSymlinkOutOfRepo(t *testing.T) {
	root := initTestRepo(t)
	writeTestFile(t, filepath.Join(root, configName), `
[[freezes]]
label = "linked"
paths = ["linked/**"]
`)
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	payload := fmt.Sprintf(`{
  "cwd": %q,
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {"file_path": %q, "content": "changed"}
}`, root, filepath.Join(root, "linked", "file.txt"))
	decision, err := EvaluateHook(SourceClaude, strings.NewReader(payload), Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Frozen() {
		t.Fatalf("edit through the frozen symlink was allowed: %+v", decision)
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
