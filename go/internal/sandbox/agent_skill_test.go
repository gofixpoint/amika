package sandbox

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestAgentSkillFS_MatchesRepositorySkill(t *testing.T) {
	source := filepath.Join("..", "..", "..", ".agents", "skills", "amika-cli")
	want := map[string]string{}
	err := filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		want[filepath.ToSlash(rel)] = string(data)
		return nil
	})
	if err != nil {
		t.Fatalf("read repository skill: %v", err)
	}
	if _, ok := want["SKILL.md"]; !ok {
		t.Fatalf("repository skill at %s has no SKILL.md", source)
	}

	got := map[string]string{}
	err = fs.WalkDir(AgentSkillFS(), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(AgentSkillFS(), path)
		got[path] = string(data)
		return err
	})
	if err != nil {
		t.Fatalf("read embedded skill: %v", err)
	}

	for name, content := range want {
		if got[name] != content {
			t.Errorf("embedded %s differs from the repository copy; run python3 sandbox-image/generate.py", name)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("embedded skill has unexpected file %s; run python3 sandbox-image/generate.py", name)
		}
	}
}
