package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setupSkillHome points the home directory at a temp dir and moves into a
// fresh project directory, so no test touches the real home.
func setupSkillHome(t *testing.T) (home, project string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	project = t.TempDir()
	t.Chdir(project)
	return home, project
}

func TestSkillInstallGlobalDefaultsToAllAgents(t *testing.T) {
	home, project := setupSkillHome(t)

	out, err := runRootCommandOutput(t, "skill", "install", "--global")
	if err != nil {
		t.Fatalf("skill install --global: %v\n%s", err, out)
	}
	claude := filepath.Join(home, ".claude", "skills", "amika-cli")
	agents := filepath.Join(home, ".agents", "skills", "amika-cli")
	for _, dir := range []string{claude, agents} {
		assertSkillInstalled(t, dir)
	}
	if !strings.Contains(out, "for claude: "+claude+"\n") ||
		!strings.Contains(out, "for codex, cursor: "+agents+"\n") {
		t.Fatalf("output does not name each install:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(project, ".claude")); !os.IsNotExist(err) {
		t.Fatalf("global install wrote into the project: %v", err)
	}
}

func TestSkillInstallLocalUsesGitRoot(t *testing.T) {
	home, project := setupSkillHome(t)
	if err := os.Mkdir(filepath.Join(project, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(project, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(nested)

	out, err := runRootCommandOutput(t, "skill", "install", "--local", "--agents", "claude")
	if err != nil {
		t.Fatalf("skill install --local: %v\n%s", err, out)
	}
	assertSkillInstalled(t, filepath.Join(project, ".claude", "skills", "amika-cli"))
	for _, unwanted := range []string{
		filepath.Join(project, ".agents"),
		filepath.Join(nested, ".claude"),
		filepath.Join(home, ".claude"),
	} {
		if _, err := os.Stat(unwanted); !os.IsNotExist(err) {
			t.Fatalf("unexpected %s: %v", unwanted, err)
		}
	}
}

func TestSkillInstallLocalOutsideGitUsesWorkingDirectory(t *testing.T) {
	_, project := setupSkillHome(t)

	if out, err := runRootCommandOutput(t, "skill", "install", "--local", "--agents", "cursor"); err != nil {
		t.Fatalf("skill install --local: %v\n%s", err, out)
	}
	assertSkillInstalled(t, filepath.Join(project, ".agents", "skills", "amika-cli"))
}

func TestSkillInstallReportsReplacedCopyAsJSON(t *testing.T) {
	home, _ := setupSkillHome(t)
	existing := filepath.Join(home, ".agents", "skills", "amika-cli")
	if err := os.MkdirAll(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(existing, "SKILL.md"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := runRootCommandOutput(t, "skill", "install", "--global", "--agents", "codex,claude", "-o", "json")
	if err != nil {
		t.Fatalf("skill install -o json: %v\n%s", err, out)
	}
	var got skillInstallResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output is not JSON: %v\n%s", err, out)
	}
	if got.Skill != "amika-cli" || got.Scope != "global" || got.Version == "" {
		t.Fatalf("unexpected result header: %+v", got)
	}
	if len(got.Installs) != 2 {
		t.Fatalf("installs = %+v, want two", got.Installs)
	}
	if got.Installs[0].Path != filepath.Join(home, ".claude", "skills", "amika-cli") || got.Installs[0].Replaced {
		t.Fatalf("claude install = %+v", got.Installs[0])
	}
	if got.Installs[1].Path != existing || !got.Installs[1].Replaced {
		t.Fatalf("codex install = %+v", got.Installs[1])
	}
	for _, key := range []string{`"skill"`, `"version"`, `"scope"`, `"installs"`, `"path"`, `"agents"`, `"replaced"`} {
		if !strings.Contains(out, key) {
			t.Fatalf("JSON missing %s: %s", key, out)
		}
	}
	assertSkillInstalled(t, existing)
}

func TestSkillInstallTextNotesReplacedCopy(t *testing.T) {
	home, _ := setupSkillHome(t)
	if out, err := runRootCommandOutput(t, "skill", "install", "--global", "--agents", "claude"); err != nil {
		t.Fatalf("first install: %v\n%s", err, out)
	}
	out, err := runRootCommandOutput(t, "skill", "install", "--global", "--agents", "claude")
	if err != nil {
		t.Fatalf("second install: %v\n%s", err, out)
	}
	want := filepath.Join(home, ".claude", "skills", "amika-cli") + " (replaced the existing copy)"
	if !strings.HasPrefix(out, "Updated amika-cli skill") || !strings.Contains(out, want) {
		t.Fatalf("output does not report the upgrade:\n%s", out)
	}
}

func TestSkillInstallFlagErrors(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"no scope", []string{}, "choose where to install: --global"},
		{"both scopes", []string{"--global", "--local"}, "--global and --local cannot be used together"},
		{"unknown agent", []string{"--global", "--agents", "claude,vim"}, `unknown agent "vim"`},
		{"empty agents", []string{"--global", "--agents", ""}, "no agents given"},
		{"positional", []string{"--global", "extra"}, "unknown command"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home, project := setupSkillHome(t)
			_, err := runRootCommandOutput(t, append([]string{"skill", "install"}, tc.args...)...)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.wantErr)
			}
			for _, root := range []string{home, project} {
				entries, err := os.ReadDir(root)
				if err != nil {
					t.Fatal(err)
				}
				if len(entries) != 0 {
					t.Fatalf("failed install wrote into %s", root)
				}
			}
		})
	}
}

func assertSkillInstalled(t *testing.T, dir string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		t.Fatalf("read installed skill: %v", err)
	}
	if !strings.HasPrefix(string(data), "---\nname: amika-cli\n") {
		t.Fatalf("installed SKILL.md is not the amika-cli skill:\n%.200s", data)
	}
	if _, err := os.Stat(filepath.Join(dir, "references", "non-interactive.md")); err != nil {
		t.Fatalf("installed skill is missing its references: %v", err)
	}
}
