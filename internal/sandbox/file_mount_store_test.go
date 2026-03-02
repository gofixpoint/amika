package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileMountStore_SaveAndGet(t *testing.T) {
	dir := t.TempDir()
	store := NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	info := FileMountInfo{
		Name:       "fm-1",
		Type:       "file",
		CreatedAt:  "2026-01-01T00:00:00Z",
		CreatedBy:  "rwcopy",
		SourcePath: "/host/config.yaml",
		CopyPath:   "/state/rwcopy-mounts.d/fm-1/config.yaml",
	}
	if err := store.Save(info); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	got, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.Name != "fm-1" {
		t.Fatalf("Name = %q, want %q", got.Name, "fm-1")
	}
	if got.SourcePath != "/host/config.yaml" {
		t.Fatalf("SourcePath = %q, want %q", got.SourcePath, "/host/config.yaml")
	}
	if got.CopyPath != "/state/rwcopy-mounts.d/fm-1/config.yaml" {
		t.Fatalf("CopyPath = %q, want %q", got.CopyPath, "/state/rwcopy-mounts.d/fm-1/config.yaml")
	}
	if got.Type != "file" {
		t.Fatalf("Type = %q, want %q", got.Type, "file")
	}
}

func TestFileMountStore_SaveReplacesExisting(t *testing.T) {
	dir := t.TempDir()
	store := NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	_ = store.Save(FileMountInfo{Name: "fm-1", CreatedBy: "rwcopy"})
	_ = store.Save(FileMountInfo{Name: "fm-1", CreatedBy: "manual"})

	got, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.CreatedBy != "manual" {
		t.Fatalf("CreatedBy = %q, want %q", got.CreatedBy, "manual")
	}
}

func TestFileMountStore_Remove(t *testing.T) {
	dir := t.TempDir()
	store := NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	_ = store.Save(FileMountInfo{Name: "fm-1"})
	_ = store.Save(FileMountInfo{Name: "fm-2"})

	if err := store.Remove("fm-1"); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := store.Get("fm-1"); err == nil {
		t.Fatal("expected not found after remove")
	}
	if _, err := store.Get("fm-2"); err != nil {
		t.Fatalf("fm-2 should still exist: %v", err)
	}
}

func TestFileMountStore_AddRemoveSandboxRef(t *testing.T) {
	dir := t.TempDir()
	store := NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	_ = store.Save(FileMountInfo{Name: "fm-1"})

	if err := store.AddSandboxRef("fm-1", "sb-a"); err != nil {
		t.Fatalf("AddSandboxRef failed: %v", err)
	}
	if err := store.AddSandboxRef("fm-1", "sb-a"); err != nil {
		t.Fatalf("AddSandboxRef duplicate failed: %v", err)
	}

	got, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(got.SandboxRefs) != 1 || got.SandboxRefs[0] != "sb-a" {
		t.Fatalf("SandboxRefs = %v, want [sb-a]", got.SandboxRefs)
	}

	if err := store.RemoveSandboxRef("fm-1", "sb-a"); err != nil {
		t.Fatalf("RemoveSandboxRef failed: %v", err)
	}

	got, _ = store.Get("fm-1")
	if len(got.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", got.SandboxRefs)
	}
}

func TestFileMountStore_FileMountsForSandboxAndInUse(t *testing.T) {
	dir := t.TempDir()
	store := NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	_ = store.Save(FileMountInfo{Name: "fm-1", SandboxRefs: []string{"sb-a", "sb-b"}})
	_ = store.Save(FileMountInfo{Name: "fm-2", SandboxRefs: []string{"sb-b"}})
	_ = store.Save(FileMountInfo{Name: "fm-3"})

	got, err := store.FileMountsForSandbox("sb-a")
	if err != nil {
		t.Fatalf("FileMountsForSandbox failed: %v", err)
	}
	if len(got) != 1 || got[0].Name != "fm-1" {
		t.Fatalf("FileMountsForSandbox(sb-a) = %+v, want fm-1", got)
	}

	inUse, err := store.IsInUse("fm-2")
	if err != nil {
		t.Fatalf("IsInUse failed: %v", err)
	}
	if !inUse {
		t.Fatal("fm-2 should be in use")
	}

	inUse, err = store.IsInUse("fm-3")
	if err != nil {
		t.Fatalf("IsInUse failed: %v", err)
	}
	if inUse {
		t.Fatal("fm-3 should not be in use")
	}
}

func TestFileMountStore_CreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "amika-state")
	store := NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	if err := store.Save(FileMountInfo{Name: "fm-1"}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("directory should have been created: %v", err)
	}
}
