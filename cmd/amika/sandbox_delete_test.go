package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
)

func TestCleanupSandboxVolumes_PreserveDefault(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", false, func(string) error {
		t.Fatal("removeVolumeFn should not be called in preserve mode")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteUnused(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	called := 0
	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(name string) error {
		called++
		if name != "vol-1" {
			t.Fatalf("unexpected volume: %s", name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if called != 1 {
		t.Fatalf("removeVolumeFn called %d times, want 1", called)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
	if _, err := store.Get("vol-1"); err == nil {
		t.Fatal("volume state entry should be removed")
	}
}

func TestCleanupSandboxVolumes_PreserveStillReferenced(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		t.Fatal("removeVolumeFn should not be called for still-referenced volume")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved (still referenced)" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 1 || info.SandboxRefs[0] != "sb-2" {
		t.Fatalf("SandboxRefs = %v, want [sb-2]", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteFailureReported(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		return fmt.Errorf("boom")
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: delete-failed: boom" {
		t.Fatalf("lines = %v", lines)
	}
}

func TestCleanupSandboxFileMounts_PreserveDefault(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyDir := filepath.Join(dir, "fm-1")
	if err := os.MkdirAll(copyDir, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	copyPath := filepath.Join(copyDir, "file.yaml")
	if err := os.WriteFile(copyPath, []byte("data"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", false)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: preserved" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", info.SandboxRefs)
	}
}

func TestCleanupSandboxFileMounts_DeleteUnused(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyDir := filepath.Join(dir, "fm-1")
	if err := os.MkdirAll(copyDir, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	copyPath := filepath.Join(copyDir, "file.yaml")
	if err := os.WriteFile(copyPath, []byte("data"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", true)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
	if _, err := store.Get("fm-1"); err == nil {
		t.Fatal("file mount state entry should be removed")
	}
	if _, err := os.Stat(copyDir); !os.IsNotExist(err) {
		t.Fatal("copy directory should have been removed")
	}
}

func TestCleanupSandboxFileMounts_PreserveStillReferenced(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyPath := filepath.Join(dir, "fm-1", "file.yaml")
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", true)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: preserved (still referenced)" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 1 || info.SandboxRefs[0] != "sb-2" {
		t.Fatalf("SandboxRefs = %v, want [sb-2]", info.SandboxRefs)
	}
}

func TestCleanupSandboxFileMounts_DeleteFailureReported(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyPath := filepath.Join(dir, "nonexistent-dir", "file.yaml")
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", true)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
}
