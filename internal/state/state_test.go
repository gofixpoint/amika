package state

import (
	"os"
	"path/filepath"
	"testing"
)

func setupTestDir(t *testing.T) (string, func()) {
	t.Helper()

	// Create a temporary directory for testing
	tmpDir, err := os.MkdirTemp("", "amika-state-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	cleanup := func() {
		os.RemoveAll(tmpDir)
	}

	return tmpDir, cleanup
}

func TestNewState(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	stateDir := filepath.Join(tmpDir, "amika-state")
	s := NewState(stateDir)

	if s.StateDir() != stateDir {
		t.Errorf("StateDir mismatch: got %s, want %s", s.StateDir(), stateDir)
	}
}

func TestSaveAndGetMount(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	stateDir := filepath.Join(tmpDir, "amika-state")
	s := NewState(stateDir)

	info := MountInfo{
		Source:  "/path/to/source",
		Target:  "/path/to/target",
		Mode:    "overlay",
		TempDir: "/tmp/amika-1234",
	}

	// Save mount
	if err := s.SaveMount(info); err != nil {
		t.Fatalf("SaveMount failed: %v", err)
	}

	// Get mount
	retrieved, err := s.GetMount(info.Target)
	if err != nil {
		t.Fatalf("GetMount failed: %v", err)
	}

	if retrieved.Source != info.Source {
		t.Errorf("Source mismatch: got %s, want %s", retrieved.Source, info.Source)
	}
	if retrieved.Target != info.Target {
		t.Errorf("Target mismatch: got %s, want %s", retrieved.Target, info.Target)
	}
	if retrieved.Mode != info.Mode {
		t.Errorf("Mode mismatch: got %s, want %s", retrieved.Mode, info.Mode)
	}
	if retrieved.TempDir != info.TempDir {
		t.Errorf("TempDir mismatch: got %s, want %s", retrieved.TempDir, info.TempDir)
	}

	// Verify the file exists
	mountsFile := filepath.Join(stateDir, "mounts.jsonl")
	if _, err := os.Stat(mountsFile); os.IsNotExist(err) {
		t.Error("mounts.jsonl file should exist after SaveMount")
	}
}

func TestSaveMountUpdatesExisting(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)

	info := MountInfo{
		Source: "/path/to/source",
		Target: "/path/to/target",
		Mode:   "ro",
	}

	// Save mount
	if err := s.SaveMount(info); err != nil {
		t.Fatalf("SaveMount failed: %v", err)
	}

	// Update the mount
	info.Mode = "rw"
	if err := s.SaveMount(info); err != nil {
		t.Fatalf("SaveMount (update) failed: %v", err)
	}

	// Get mount and verify update
	retrieved, err := s.GetMount(info.Target)
	if err != nil {
		t.Fatalf("GetMount failed: %v", err)
	}

	if retrieved.Mode != "rw" {
		t.Errorf("Mode should be updated to 'rw', got %s", retrieved.Mode)
	}

	// Should still only have one mount
	mounts, err := s.ListMounts()
	if err != nil {
		t.Fatalf("ListMounts failed: %v", err)
	}
	if len(mounts) != 1 {
		t.Errorf("expected 1 mount after update, got %d", len(mounts))
	}
}

func TestGetMountNotFound(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)

	_, err := s.GetMount("/nonexistent/target")
	if err == nil {
		t.Error("expected error for nonexistent mount, got nil")
	}
}

func TestRemoveMount(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)

	info := MountInfo{
		Source: "/path/to/source",
		Target: "/path/to/target",
		Mode:   "ro",
	}

	// Save mount
	if err := s.SaveMount(info); err != nil {
		t.Fatalf("SaveMount failed: %v", err)
	}

	// Remove mount
	if err := s.RemoveMount(info.Target); err != nil {
		t.Fatalf("RemoveMount failed: %v", err)
	}

	// Verify it's gone
	_, err := s.GetMount(info.Target)
	if err == nil {
		t.Error("expected error after removing mount, got nil")
	}
}

func TestRemoveMountNonexistent(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)

	// Removing nonexistent mount should not error
	if err := s.RemoveMount("/nonexistent/target"); err != nil {
		t.Errorf("RemoveMount of nonexistent target should not error: %v", err)
	}
}

func TestListMounts(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)

	// Initially empty
	mounts, err := s.ListMounts()
	if err != nil {
		t.Fatalf("ListMounts failed: %v", err)
	}
	if len(mounts) != 0 {
		t.Errorf("expected 0 mounts, got %d", len(mounts))
	}

	// Add some mounts
	infos := []MountInfo{
		{Source: "/src1", Target: "/target1", Mode: "ro"},
		{Source: "/src2", Target: "/target2", Mode: "rw"},
		{Source: "/src3", Target: "/target3", Mode: "overlay", TempDir: "/tmp/test"},
	}

	for _, info := range infos {
		if err := s.SaveMount(info); err != nil {
			t.Fatalf("SaveMount failed: %v", err)
		}
	}

	// List should return all
	mounts, err = s.ListMounts()
	if err != nil {
		t.Fatalf("ListMounts failed: %v", err)
	}
	if len(mounts) != 3 {
		t.Errorf("expected 3 mounts, got %d", len(mounts))
	}
}

func TestMountExists(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)
	target := "/path/to/target"

	// Should not exist initially
	if s.MountExists(target) {
		t.Error("mount should not exist initially")
	}

	// Save mount
	info := MountInfo{
		Source: "/path/to/source",
		Target: target,
		Mode:   "ro",
	}
	if err := s.SaveMount(info); err != nil {
		t.Fatalf("SaveMount failed: %v", err)
	}

	// Should exist now
	if !s.MountExists(target) {
		t.Error("mount should exist after save")
	}

	// Remove mount
	if err := s.RemoveMount(target); err != nil {
		t.Fatalf("RemoveMount failed: %v", err)
	}

	// Should not exist after removal
	if s.MountExists(target) {
		t.Error("mount should not exist after removal")
	}
}

func TestStateDir(t *testing.T) {
	tmpDir, cleanup := setupTestDir(t)
	defer cleanup()

	s := NewState(tmpDir)

	if s.StateDir() != tmpDir {
		t.Errorf("StateDir mismatch: got %s, want %s", s.StateDir(), tmpDir)
	}
}
