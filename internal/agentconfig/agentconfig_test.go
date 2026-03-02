package agentconfig

import (
	"os"
	"path/filepath"
	"testing"
)

// writeFixtureFile creates a file at homeDir/rel with parent directories.
func writeFixtureFile(t *testing.T, homeDir, rel string) {
	t.Helper()
	full := filepath.Join(homeDir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeMounts_AllExist(t *testing.T) {
	home := t.TempDir()
	writeFixtureFile(t, home, ".claude.json.api")
	writeFixtureFile(t, home, ".claude.json")
	writeFixtureFile(t, home, filepath.Join(".claude", ".credentials.json"))
	writeFixtureFile(t, home, ".claude-oauth-credentials.json")

	specs := ClaudeMounts(home)
	if len(specs) != 4 {
		t.Fatalf("expected 4 specs, got %d", len(specs))
	}

	wantContainers := []string{
		"/home/amika/.claude.json.api",
		"/home/amika/.claude.json",
		"/home/amika/.claude/.credentials.json",
		"/home/amika/.claude-oauth-credentials.json",
	}
	for i, want := range wantContainers {
		if specs[i].ContainerPath != want {
			t.Errorf("specs[%d].ContainerPath = %q, want %q", i, specs[i].ContainerPath, want)
		}
		if specs[i].IsDir {
			t.Errorf("specs[%d].IsDir = true, want false", i)
		}
	}
}

func TestClaudeMounts_SomeExist(t *testing.T) {
	home := t.TempDir()
	writeFixtureFile(t, home, ".claude.json")

	specs := ClaudeMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if specs[0].ContainerPath != "/home/amika/.claude.json" {
		t.Errorf("ContainerPath = %q, want /home/amika/.claude.json", specs[0].ContainerPath)
	}
	if specs[0].IsDir {
		t.Error("IsDir = true, want false")
	}
}

func TestClaudeMounts_NoneExist(t *testing.T) {
	home := t.TempDir()
	specs := ClaudeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil, got %v", specs)
	}
}

func TestClaudeMounts_DirectoryIsSkipped(t *testing.T) {
	home := t.TempDir()
	// Create .claude.json as a directory — should be skipped since we expect a file.
	if err := os.Mkdir(filepath.Join(home, ".claude.json"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := ClaudeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil when path is a directory, got %v", specs)
	}
}

func TestOpenCodeMounts_AllExist(t *testing.T) {
	home := t.TempDir()
	writeFixtureFile(t, home, filepath.Join(".local", "share", "opencode", "auth.json"))
	writeFixtureFile(t, home, filepath.Join(".local", "state", "opencode", "model.json"))

	specs := OpenCodeMounts(home)
	if len(specs) != 2 {
		t.Fatalf("expected 2 specs, got %d", len(specs))
	}

	wantContainers := []string{
		"/home/amika/.local/share/opencode/auth.json",
		"/home/amika/.local/state/opencode/model.json",
	}
	for i, want := range wantContainers {
		if specs[i].ContainerPath != want {
			t.Errorf("specs[%d].ContainerPath = %q, want %q", i, specs[i].ContainerPath, want)
		}
		if specs[i].IsDir {
			t.Errorf("specs[%d].IsDir = true, want false", i)
		}
	}
}

func TestOpenCodeMounts_OnlyAuth(t *testing.T) {
	home := t.TempDir()
	writeFixtureFile(t, home, filepath.Join(".local", "share", "opencode", "auth.json"))

	specs := OpenCodeMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if specs[0].ContainerPath != "/home/amika/.local/share/opencode/auth.json" {
		t.Errorf("ContainerPath = %q, want /home/amika/.local/share/opencode/auth.json", specs[0].ContainerPath)
	}
}

func TestOpenCodeMounts_NoneExist(t *testing.T) {
	home := t.TempDir()
	specs := OpenCodeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil, got %v", specs)
	}
}

func TestOpenCodeMounts_DirectoryIsSkipped(t *testing.T) {
	home := t.TempDir()
	// Create auth.json as a directory — should be skipped.
	if err := os.MkdirAll(filepath.Join(home, ".local", "share", "opencode", "auth.json"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := OpenCodeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil when path is a directory, got %v", specs)
	}
}

func TestCodexMounts_FileExists(t *testing.T) {
	home := t.TempDir()
	writeFixtureFile(t, home, filepath.Join(".codex", "auth.json"))

	specs := CodexMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if specs[0].HostPath != filepath.Join(home, ".codex", "auth.json") {
		t.Errorf("HostPath = %q, want %q", specs[0].HostPath, filepath.Join(home, ".codex", "auth.json"))
	}
	if specs[0].ContainerPath != "/home/amika/.codex/auth.json" {
		t.Errorf("ContainerPath = %q, want /home/amika/.codex/auth.json", specs[0].ContainerPath)
	}
	if specs[0].IsDir {
		t.Error("IsDir = true, want false")
	}
}

func TestCodexMounts_NotPresent(t *testing.T) {
	home := t.TempDir()
	specs := CodexMounts(home)
	if specs != nil {
		t.Fatalf("expected nil, got %v", specs)
	}
}

func TestCodexMounts_DirectoryIsSkipped(t *testing.T) {
	home := t.TempDir()
	// Create auth.json as a directory — should be skipped.
	if err := os.MkdirAll(filepath.Join(home, ".codex", "auth.json"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := CodexMounts(home)
	if specs != nil {
		t.Fatalf("expected nil when path is a directory, got %v", specs)
	}
}

func TestAllMounts_Combined(t *testing.T) {
	home := t.TempDir()

	// Create one file from each agent.
	writeFixtureFile(t, home, ".claude.json")
	writeFixtureFile(t, home, filepath.Join(".local", "share", "opencode", "auth.json"))
	writeFixtureFile(t, home, filepath.Join(".codex", "auth.json"))

	specs := AllMounts(home)
	if len(specs) != 3 {
		t.Fatalf("expected 3 specs, got %d", len(specs))
	}

	wantContainers := map[string]bool{
		"/home/amika/.claude.json":                    true,
		"/home/amika/.local/share/opencode/auth.json": true,
		"/home/amika/.codex/auth.json":                true,
	}
	for _, s := range specs {
		if !wantContainers[s.ContainerPath] {
			t.Errorf("unexpected ContainerPath %q", s.ContainerPath)
		}
		if s.IsDir {
			t.Errorf("IsDir = true for %q, want false", s.ContainerPath)
		}
		delete(wantContainers, s.ContainerPath)
	}
	for path := range wantContainers {
		t.Errorf("missing expected ContainerPath %q", path)
	}
}

func TestRWCopyMounts(t *testing.T) {
	specs := []MountSpec{
		{HostPath: "/home/user/.claude.json", ContainerPath: "/home/amika/.claude.json", IsDir: false},
		{HostPath: "/home/user/.codex/auth.json", ContainerPath: "/home/amika/.codex/auth.json", IsDir: false},
	}

	mounts := RWCopyMounts(specs)
	if len(mounts) != 2 {
		t.Fatalf("expected 2 mounts, got %d", len(mounts))
	}

	for i, m := range mounts {
		if m.Type != "bind" {
			t.Errorf("mount[%d] Type = %q, want \"bind\"", i, m.Type)
		}
		if m.Mode != "rwcopy" {
			t.Errorf("mount[%d] Mode = %q, want \"rwcopy\"", i, m.Mode)
		}
		if m.Source != specs[i].HostPath {
			t.Errorf("mount[%d] Source = %q, want %q", i, m.Source, specs[i].HostPath)
		}
		if m.Target != specs[i].ContainerPath {
			t.Errorf("mount[%d] Target = %q, want %q", i, m.Target, specs[i].ContainerPath)
		}
	}
}

func TestRWCopyMounts_Empty(t *testing.T) {
	mounts := RWCopyMounts(nil)
	if len(mounts) != 0 {
		t.Fatalf("expected 0 mounts, got %d", len(mounts))
	}
}
