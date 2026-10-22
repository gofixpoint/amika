package agentskill

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func TestParseAgents(t *testing.T) {
	cases := []struct {
		name  string
		input []string
		want  []Agent
	}{
		{"single", []string{"claude"}, []Agent{Claude}},
		{"canonical order", []string{"cursor", "claude"}, []Agent{Claude, Cursor}},
		{"deduplicates", []string{"codex", "codex"}, []Agent{Codex}},
		{"case and space", []string{" Claude ", "CURSOR"}, []Agent{Claude, Cursor}},
		{"skips empty entries", []string{"codex", ""}, []Agent{Codex}},
		{"all", []string{"claude", "codex", "cursor"}, AllAgents},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseAgents(tc.input)
			if err != nil {
				t.Fatalf("ParseAgents(%q): %v", tc.input, err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParseAgents(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestParseAgentsRejects(t *testing.T) {
	cases := []struct {
		name    string
		input   []string
		wantErr string
	}{
		{"unknown", []string{"claude", "copilot"}, `unknown agent "copilot"; choose from claude, codex, cursor`},
		{"empty", []string{""}, "no agents given"},
		{"none", nil, "no agents given"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseAgents(tc.input)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("ParseAgents(%q) error = %v, want it to contain %q", tc.input, err, tc.wantErr)
			}
		})
	}
}

func TestResolveTargets(t *testing.T) {
	root := t.TempDir()
	claudeDir := filepath.Join(root, ".claude", "skills", "amika-cli")
	agentsDir := filepath.Join(root, ".agents", "skills", "amika-cli")

	cases := []struct {
		name   string
		agents []Agent
		want   []Target
	}{
		{"claude", []Agent{Claude}, []Target{{claudeDir, []Agent{Claude}}}},
		{"codex", []Agent{Codex}, []Target{{agentsDir, []Agent{Codex}}}},
		{"cursor", []Agent{Cursor}, []Target{{agentsDir, []Agent{Cursor}}}},
		{"codex and cursor share a copy", []Agent{Codex, Cursor}, []Target{{agentsDir, []Agent{Codex, Cursor}}}},
		{"all", AllAgents, []Target{
			{claudeDir, []Agent{Claude}},
			{agentsDir, []Agent{Codex, Cursor}},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveTargets(root, tc.agents)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ResolveTargets = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestInstallWritesTree(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".claude", "skills", "amika-cli")

	replaced, err := Install(testSkill("v1"), dir)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if replaced {
		t.Fatal("first install reported replacing an existing copy")
	}
	assertFile(t, filepath.Join(dir, "SKILL.md"), "skill v1")
	assertFile(t, filepath.Join(dir, "references", "a.md"), "ref v1")

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("skill dir mode = %v, want 0755", info.Mode().Perm())
	}
	assertNoStaging(t, filepath.Dir(dir))
}

func TestInstallReplacesExistingCopy(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "amika-cli")
	if err := os.MkdirAll(filepath.Join(dir, "references"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "references", "stale.md"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	replaced, err := Install(testSkill("v2"), dir)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !replaced {
		t.Fatal("install over an existing copy did not report replacing it")
	}
	assertFile(t, filepath.Join(dir, "SKILL.md"), "skill v2")
	if _, err := os.Stat(filepath.Join(dir, "references", "stale.md")); !os.IsNotExist(err) {
		t.Fatalf("stale reference survived the upgrade: %v", err)
	}
	assertNoStaging(t, filepath.Dir(dir))
}

func TestInstallReplacesSymlinkWithoutTouchingTarget(t *testing.T) {
	root := t.TempDir()
	linked := filepath.Join(root, "elsewhere")
	if err := os.MkdirAll(linked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(linked, "keep.md"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "skills", "amika-cli")
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linked, dir); err != nil {
		t.Fatal(err)
	}

	replaced, err := Install(testSkill("v1"), dir)
	if err != nil {
		t.Fatalf("Install: %v", err)
	}
	if !replaced {
		t.Fatal("install over a symlink did not report replacing it")
	}
	assertFile(t, filepath.Join(dir, "SKILL.md"), "skill v1")
	assertFile(t, filepath.Join(linked, "keep.md"), "keep")
}

func TestInstallAll(t *testing.T) {
	root := t.TempDir()
	targets := ResolveTargets(root, AllAgents)
	if _, err := Install(testSkill("old"), targets[1].Dir); err != nil {
		t.Fatal(err)
	}

	results, err := InstallAll(testSkill("new"), targets)
	if err != nil {
		t.Fatalf("InstallAll: %v", err)
	}
	want := []Result{
		{Path: filepath.Join(root, ".claude", "skills", "amika-cli"), Agents: []Agent{Claude}, Replaced: false},
		{Path: filepath.Join(root, ".agents", "skills", "amika-cli"), Agents: []Agent{Codex, Cursor}, Replaced: true},
	}
	if !reflect.DeepEqual(results, want) {
		t.Fatalf("InstallAll = %+v, want %+v", results, want)
	}
	for _, result := range results {
		assertFile(t, filepath.Join(result.Path, "SKILL.md"), "skill new")
	}
}

func testSkill(version string) fstest.MapFS {
	return fstest.MapFS{
		"SKILL.md":        {Data: []byte("skill " + version)},
		"references/a.md": {Data: []byte("ref " + version)},
	}
}

func assertFile(t *testing.T, path, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(data) != want {
		t.Fatalf("%s = %q, want %q", path, data, want)
	}
}

func assertNoStaging(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			t.Fatalf("staging directory %s left behind", entry.Name())
		}
	}
}
