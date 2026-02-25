package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSandboxStore_SaveAndGet(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	info := SandboxInfo{
		Name:        "test-sb",
		Provider:    "docker",
		ContainerID: "abc123",
		Image:       "ubuntu:latest",
		CreatedAt:   "2025-01-01T00:00:00Z",
	}

	if err := store.Save(info); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	got, err := store.Get("test-sb")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.ContainerID != "abc123" {
		t.Errorf("ContainerID = %q, want %q", got.ContainerID, "abc123")
	}
	if got.Provider != "docker" {
		t.Errorf("Provider = %q, want %q", got.Provider, "docker")
	}
}

func TestSandboxStore_GetNotFound(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	_, err := store.Get("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent sandbox")
	}
}

func TestSandboxStore_SaveReplacesExisting(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	store.Save(SandboxInfo{Name: "sb1", ContainerID: "old"})
	store.Save(SandboxInfo{Name: "sb1", ContainerID: "new"})

	got, _ := store.Get("sb1")
	if got.ContainerID != "new" {
		t.Errorf("ContainerID = %q, want %q", got.ContainerID, "new")
	}

	all, _ := store.List()
	if len(all) != 1 {
		t.Errorf("expected 1 sandbox, got %d", len(all))
	}
}

func TestSandboxStore_Remove(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	store.Save(SandboxInfo{Name: "sb1"})
	store.Save(SandboxInfo{Name: "sb2"})

	if err := store.Remove("sb1"); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	_, err := store.Get("sb1")
	if err == nil {
		t.Fatal("expected error after removing sb1")
	}

	got, err := store.Get("sb2")
	if err != nil {
		t.Fatalf("sb2 should still exist: %v", err)
	}
	if got.Name != "sb2" {
		t.Errorf("Name = %q, want %q", got.Name, "sb2")
	}
}

func TestSandboxStore_RemoveNonexistent(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	// Should not error when removing something that doesn't exist
	if err := store.Remove("nope"); err != nil {
		t.Fatalf("Remove of nonexistent should not error: %v", err)
	}
}

func TestSandboxStore_List(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	store.Save(SandboxInfo{Name: "a"})
	store.Save(SandboxInfo{Name: "b"})
	store.Save(SandboxInfo{Name: "c"})

	all, err := store.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("expected 3 sandboxes, got %d", len(all))
	}
}

func TestSandboxStore_CreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "amika-state")
	store := NewSandboxStore(dir)

	if err := store.Save(SandboxInfo{Name: "sb1"}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("directory should have been created: %v", err)
	}
}

func TestSandboxStore_MountsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	info := SandboxInfo{
		Name:     "sb-mounts",
		Provider: "docker",
		Image:    "ubuntu:latest",
		Mounts: []MountBinding{
			{Source: "/host/src", Target: "/workspace", Mode: "ro"},
			{Source: "/host/data", Target: "/data", Mode: "rw"},
		},
	}

	if err := store.Save(info); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	got, err := store.Get("sb-mounts")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(got.Mounts) != 2 {
		t.Fatalf("expected 2 mounts, got %d", len(got.Mounts))
	}
	if got.Mounts[0].Source != "/host/src" || got.Mounts[0].Target != "/workspace" || got.Mounts[0].Mode != "ro" {
		t.Errorf("mount[0] = %+v, unexpected", got.Mounts[0])
	}
	if got.Mounts[1].Source != "/host/data" || got.Mounts[1].Target != "/data" || got.Mounts[1].Mode != "rw" {
		t.Errorf("mount[1] = %+v, unexpected", got.Mounts[1])
	}
}

func TestSandboxStore_NoMountsOmitted(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	store.Save(SandboxInfo{Name: "no-mounts", Provider: "docker"})

	got, _ := store.Get("no-mounts")
	if got.Mounts != nil {
		t.Errorf("expected nil mounts, got %v", got.Mounts)
	}
}

func TestSandboxStore_EmptyFileReturnsNil(t *testing.T) {
	dir := t.TempDir()
	store := NewSandboxStore(dir)

	all, err := store.List()
	if err != nil {
		t.Fatalf("List on empty store should not error: %v", err)
	}
	if all != nil {
		t.Errorf("expected nil, got %v", all)
	}
}
