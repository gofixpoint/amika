package agentconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestClaudeMounts_BothExist(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, ".claude"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}

	specs := ClaudeMounts(home)
	if len(specs) != 2 {
		t.Fatalf("expected 2 specs, got %d", len(specs))
	}

	dir := specs[0]
	if dir.HostPath != filepath.Join(home, ".claude") {
		t.Errorf("dir HostPath = %q, want %q", dir.HostPath, filepath.Join(home, ".claude"))
	}
	if dir.ContainerPath != "/home/amika/.claude" {
		t.Errorf("dir ContainerPath = %q, want /home/amika/.claude", dir.ContainerPath)
	}
	if !dir.IsDir {
		t.Error("dir IsDir = false, want true")
	}

	file := specs[1]
	if file.HostPath != filepath.Join(home, ".claude.json") {
		t.Errorf("file HostPath = %q, want %q", file.HostPath, filepath.Join(home, ".claude.json"))
	}
	if file.ContainerPath != "/home/amika/.claude.json" {
		t.Errorf("file ContainerPath = %q, want /home/amika/.claude.json", file.ContainerPath)
	}
	if file.IsDir {
		t.Error("file IsDir = true, want false")
	}
}

func TestClaudeMounts_OnlyDir(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, ".claude"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := ClaudeMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if !specs[0].IsDir {
		t.Error("expected IsDir = true")
	}
	if specs[0].ContainerPath != "/home/amika/.claude" {
		t.Errorf("ContainerPath = %q, want /home/amika/.claude", specs[0].ContainerPath)
	}
}

func TestClaudeMounts_OnlyFile(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}

	specs := ClaudeMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if specs[0].IsDir {
		t.Error("expected IsDir = false")
	}
	if specs[0].ContainerPath != "/home/amika/.claude.json" {
		t.Errorf("ContainerPath = %q, want /home/amika/.claude.json", specs[0].ContainerPath)
	}
}

func TestClaudeMounts_NeitherExists(t *testing.T) {
	home := t.TempDir()
	specs := ClaudeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil, got %v", specs)
	}
}

func TestClaudeMounts_ClaudeIsFile(t *testing.T) {
	home := t.TempDir()
	// .claude exists as a regular file, not a directory — should not be included
	if err := os.WriteFile(filepath.Join(home, ".claude"), []byte("not a dir"), 0644); err != nil {
		t.Fatal(err)
	}

	specs := ClaudeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil when .claude is a file, got %v", specs)
	}
}

func TestOpenCodeMounts_AllExist(t *testing.T) {
	home := t.TempDir()
	mkdirAll := func(rel string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(home, rel), 0755); err != nil {
			t.Fatal(err)
		}
	}
	mkdirAll(".config/opencode")
	mkdirAll(filepath.Join(".local", "share", "opencode"))
	mkdirAll(filepath.Join(".local", "state", "opencode"))

	specs := OpenCodeMounts(home)
	if len(specs) != 3 {
		t.Fatalf("expected 3 specs, got %d", len(specs))
	}

	wantContainers := []string{
		"/home/amika/.config/opencode",
		"/home/amika/.local/share/opencode",
		"/home/amika/.local/state/opencode",
	}
	for i, want := range wantContainers {
		if specs[i].ContainerPath != want {
			t.Errorf("specs[%d].ContainerPath = %q, want %q", i, specs[i].ContainerPath, want)
		}
		if !specs[i].IsDir {
			t.Errorf("specs[%d].IsDir = false, want true", i)
		}
	}
}

func TestOpenCodeMounts_SomeExist(t *testing.T) {
	home := t.TempDir()
	// Only create .config/opencode
	if err := os.MkdirAll(filepath.Join(home, ".config", "opencode"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := OpenCodeMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if specs[0].ContainerPath != "/home/amika/.config/opencode" {
		t.Errorf("ContainerPath = %q, want /home/amika/.config/opencode", specs[0].ContainerPath)
	}
}

func TestOpenCodeMounts_NoneExist(t *testing.T) {
	home := t.TempDir()
	specs := OpenCodeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil, got %v", specs)
	}
}

func TestOpenCodeMounts_PathIsFile(t *testing.T) {
	home := t.TempDir()
	// Create .config/opencode as a file, not a directory
	if err := os.MkdirAll(filepath.Join(home, ".config"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".config", "opencode"), []byte("not a dir"), 0644); err != nil {
		t.Fatal(err)
	}

	specs := OpenCodeMounts(home)
	if specs != nil {
		t.Fatalf("expected nil when opencode path is a file, got %v", specs)
	}
}

func TestCodexMounts_DirExists(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, ".codex"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := CodexMounts(home)
	if len(specs) != 1 {
		t.Fatalf("expected 1 spec, got %d", len(specs))
	}
	if specs[0].HostPath != filepath.Join(home, ".codex") {
		t.Errorf("HostPath = %q, want %q", specs[0].HostPath, filepath.Join(home, ".codex"))
	}
	if specs[0].ContainerPath != "/home/amika/.codex" {
		t.Errorf("ContainerPath = %q, want /home/amika/.codex", specs[0].ContainerPath)
	}
	if !specs[0].IsDir {
		t.Error("IsDir = false, want true")
	}
}

func TestCodexMounts_NotPresent(t *testing.T) {
	home := t.TempDir()
	specs := CodexMounts(home)
	if specs != nil {
		t.Fatalf("expected nil, got %v", specs)
	}
}

func TestCodexMounts_PathIsFile(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".codex"), []byte("not a dir"), 0644); err != nil {
		t.Fatal(err)
	}

	specs := CodexMounts(home)
	if specs != nil {
		t.Fatalf("expected nil when .codex is a file, got %v", specs)
	}
}

func TestAllMounts_Combined(t *testing.T) {
	home := t.TempDir()

	// Create one item from each discovery function
	if err := os.Mkdir(filepath.Join(home, ".claude"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".config", "opencode"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(home, ".codex"), 0755); err != nil {
		t.Fatal(err)
	}

	specs := AllMounts(home)
	if len(specs) != 3 {
		t.Fatalf("expected 3 specs, got %d", len(specs))
	}

	wantContainers := map[string]bool{
		"/home/amika/.claude":          true,
		"/home/amika/.config/opencode": true,
		"/home/amika/.codex":           true,
	}
	for _, s := range specs {
		if !wantContainers[s.ContainerPath] {
			t.Errorf("unexpected ContainerPath %q", s.ContainerPath)
		}
		delete(wantContainers, s.ContainerPath)
	}
	for path := range wantContainers {
		t.Errorf("missing expected ContainerPath %q", path)
	}
}

func TestRWCopyMounts(t *testing.T) {
	specs := []MountSpec{
		{HostPath: "/home/user/.claude", ContainerPath: "/home/amika/.claude", IsDir: true},
		{HostPath: "/home/user/.claude.json", ContainerPath: "/home/amika/.claude.json", IsDir: false},
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

func TestIsAgentPreset(t *testing.T) {
	tests := []struct {
		preset string
		want   bool
	}{
		{"claude", true},
		{"coder", true},
		{"", false},
		{"custom", false},
	}
	for _, tt := range tests {
		if got := IsAgentPreset(tt.preset); got != tt.want {
			t.Errorf("IsAgentPreset(%q) = %v, want %v", tt.preset, got, tt.want)
		}
	}
}
