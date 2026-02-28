package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVolumeStore_SaveAndGet(t *testing.T) {
	dir := t.TempDir()
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))

	info := VolumeInfo{
		Name:       "vol-1",
		CreatedAt:  "2026-01-01T00:00:00Z",
		CreatedBy:  "rwcopy",
		SourcePath: "/host/data",
	}
	if err := store.Save(info); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	got, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.Name != "vol-1" {
		t.Fatalf("Name = %q, want %q", got.Name, "vol-1")
	}
	if got.SourcePath != "/host/data" {
		t.Fatalf("SourcePath = %q, want %q", got.SourcePath, "/host/data")
	}
}

func TestVolumeStore_SaveReplacesExisting(t *testing.T) {
	dir := t.TempDir()
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))

	_ = store.Save(VolumeInfo{Name: "vol-1", CreatedBy: "rwcopy"})
	_ = store.Save(VolumeInfo{Name: "vol-1", CreatedBy: "manual-attach"})

	got, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.CreatedBy != "manual-attach" {
		t.Fatalf("CreatedBy = %q, want %q", got.CreatedBy, "manual-attach")
	}
}

func TestVolumeStore_Remove(t *testing.T) {
	dir := t.TempDir()
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))

	_ = store.Save(VolumeInfo{Name: "vol-1"})
	_ = store.Save(VolumeInfo{Name: "vol-2"})

	if err := store.Remove("vol-1"); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := store.Get("vol-1"); err == nil {
		t.Fatal("expected not found after remove")
	}
	if _, err := store.Get("vol-2"); err != nil {
		t.Fatalf("vol-2 should still exist: %v", err)
	}
}

func TestVolumeStore_AddRemoveSandboxRef(t *testing.T) {
	dir := t.TempDir()
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))

	_ = store.Save(VolumeInfo{Name: "vol-1"})

	if err := store.AddSandboxRef("vol-1", "sb-a"); err != nil {
		t.Fatalf("AddSandboxRef failed: %v", err)
	}
	if err := store.AddSandboxRef("vol-1", "sb-a"); err != nil {
		t.Fatalf("AddSandboxRef duplicate failed: %v", err)
	}

	got, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(got.SandboxRefs) != 1 || got.SandboxRefs[0] != "sb-a" {
		t.Fatalf("SandboxRefs = %v, want [sb-a]", got.SandboxRefs)
	}

	if err := store.RemoveSandboxRef("vol-1", "sb-a"); err != nil {
		t.Fatalf("RemoveSandboxRef failed: %v", err)
	}

	got, _ = store.Get("vol-1")
	if len(got.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", got.SandboxRefs)
	}
}

func TestVolumeStore_VolumesForSandboxAndInUse(t *testing.T) {
	dir := t.TempDir()
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))

	_ = store.Save(VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-a", "sb-b"}})
	_ = store.Save(VolumeInfo{Name: "vol-2", SandboxRefs: []string{"sb-b"}})
	_ = store.Save(VolumeInfo{Name: "vol-3"})

	got, err := store.VolumesForSandbox("sb-a")
	if err != nil {
		t.Fatalf("VolumesForSandbox failed: %v", err)
	}
	if len(got) != 1 || got[0].Name != "vol-1" {
		t.Fatalf("VolumesForSandbox(sb-a) = %+v, want vol-1", got)
	}

	inUse, err := store.IsInUse("vol-2")
	if err != nil {
		t.Fatalf("IsInUse failed: %v", err)
	}
	if !inUse {
		t.Fatal("vol-2 should be in use")
	}

	inUse, err = store.IsInUse("vol-3")
	if err != nil {
		t.Fatalf("IsInUse failed: %v", err)
	}
	if inUse {
		t.Fatal("vol-3 should not be in use")
	}
}

func TestVolumeStore_CreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "amika-state")
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))

	if err := store.Save(VolumeInfo{Name: "vol-1"}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("directory should have been created: %v", err)
	}
}
