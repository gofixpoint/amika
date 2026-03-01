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
