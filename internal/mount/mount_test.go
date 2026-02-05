package mount

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/wisp/internal/deps"
	"github.com/gofixpoint/wisp/internal/state"
)

// skipIfDepsNotInstalled skips the test if macFUSE or bindfs are not installed.
func skipIfDepsNotInstalled(t *testing.T) {
	t.Helper()
	if err := deps.CheckAll(); err != nil {
		t.Skipf("Skipping test: %v", err)
	}
}

// setupTestDirs creates temp source, target, and state directories.
// Returns source dir, target dir, state instance, and cleanup function.
func setupTestDirs(t *testing.T) (srcDir, targetDir string, st state.State, cleanup func()) {
	t.Helper()

	// Create temp base directory
	baseDir, err := os.MkdirTemp("", "wisp-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp base directory: %v", err)
	}

	srcDir = filepath.Join(baseDir, "source")
	targetDir = filepath.Join(baseDir, "target")
	stateDir := filepath.Join(baseDir, "state")

	if err := os.MkdirAll(srcDir, 0755); err != nil {
		os.RemoveAll(baseDir)
		t.Fatalf("Failed to create source directory: %v", err)
	}

	if err := os.MkdirAll(stateDir, 0755); err != nil {
		os.RemoveAll(baseDir)
		t.Fatalf("Failed to create state directory: %v", err)
	}

	st = state.NewState(stateDir, ".wispstate")

	cleanup = func() {
		// Try to unmount if still mounted (cleanup on test failure)
		if st.MountExists(targetDir) {
			Unmount(targetDir, st)
		}
		os.RemoveAll(baseDir)
	}

	return srcDir, targetDir, st, cleanup
}

// TestValidateMode tests mode validation (no deps needed).
func TestValidateMode(t *testing.T) {
	tests := []struct {
		mode    string
		wantErr bool
	}{
		{"ro", false},
		{"rw", false},
		{"overlay", false},
		{"invalid", true},
		{"", true},
		{"RO", true}, // case sensitive
	}

	for _, tt := range tests {
		t.Run(tt.mode, func(t *testing.T) {
			err := ValidateMode(tt.mode)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateMode(%q) error = %v, wantErr %v", tt.mode, err, tt.wantErr)
			}
		})
	}
}

// TestMountReadOnly tests mounting in read-only mode.
func TestMountReadOnly(t *testing.T) {
	skipIfDepsNotInstalled(t)

	srcDir, targetDir, st, cleanup := setupTestDirs(t)
	defer cleanup()

	// Create test file in source
	testFile := filepath.Join(srcDir, "test.txt")
	testContent := []byte("hello world")
	if err := os.WriteFile(testFile, testContent, 0644); err != nil {
		t.Fatalf("Failed to write test file: %v", err)
	}

	// Mount in read-only mode
	if err := Mount(srcDir, targetDir, "ro", st); err != nil {
		t.Fatalf("Mount failed: %v", err)
	}

	// Verify can read file from target
	targetFile := filepath.Join(targetDir, "test.txt")
	content, err := os.ReadFile(targetFile)
	if err != nil {
		t.Errorf("Failed to read file from target: %v", err)
	}
	if string(content) != string(testContent) {
		t.Errorf("Content mismatch: got %q, want %q", content, testContent)
	}

	// Verify cannot write to target (read-only)
	newFile := filepath.Join(targetDir, "new.txt")
	err = os.WriteFile(newFile, []byte("new content"), 0644)
	if err == nil {
		t.Error("Expected write to read-only mount to fail, but it succeeded")
	}

	// Verify mount exists in state
	if !st.MountExists(targetDir) {
		t.Error("Mount not found in state")
	}

	// Unmount
	if err := Unmount(targetDir, st); err != nil {
		t.Errorf("Unmount failed: %v", err)
	}

	// Verify mount removed from state
	if st.MountExists(targetDir) {
		t.Error("Mount still exists in state after unmount")
	}
}

// TestMountReadWrite tests mounting in read-write mode.
func TestMountReadWrite(t *testing.T) {
	skipIfDepsNotInstalled(t)

	srcDir, targetDir, st, cleanup := setupTestDirs(t)
	defer cleanup()

	// Create test file in source
	testFile := filepath.Join(srcDir, "test.txt")
	testContent := []byte("hello world")
	if err := os.WriteFile(testFile, testContent, 0644); err != nil {
		t.Fatalf("Failed to write test file: %v", err)
	}

	// Mount in read-write mode
	if err := Mount(srcDir, targetDir, "rw", st); err != nil {
		t.Fatalf("Mount failed: %v", err)
	}

	// Verify can read file from target
	targetFile := filepath.Join(targetDir, "test.txt")
	content, err := os.ReadFile(targetFile)
	if err != nil {
		t.Errorf("Failed to read file from target: %v", err)
	}
	if string(content) != string(testContent) {
		t.Errorf("Content mismatch: got %q, want %q", content, testContent)
	}

	// Write new file to target
	newFile := filepath.Join(targetDir, "new.txt")
	newContent := []byte("new content")
	if err := os.WriteFile(newFile, newContent, 0644); err != nil {
		t.Errorf("Failed to write new file to target: %v", err)
	}

	// Verify file appears in source (writes sync back)
	sourceNewFile := filepath.Join(srcDir, "new.txt")
	content, err = os.ReadFile(sourceNewFile)
	if err != nil {
		t.Errorf("New file not found in source: %v", err)
	}
	if string(content) != string(newContent) {
		t.Errorf("New file content mismatch in source: got %q, want %q", content, newContent)
	}

	// Unmount
	if err := Unmount(targetDir, st); err != nil {
		t.Errorf("Unmount failed: %v", err)
	}

	// Verify mount removed from state
	if st.MountExists(targetDir) {
		t.Error("Mount still exists in state after unmount")
	}
}

// TestMountOverlay tests mounting in overlay mode.
func TestMountOverlay(t *testing.T) {
	skipIfDepsNotInstalled(t)

	srcDir, targetDir, st, cleanup := setupTestDirs(t)
	defer cleanup()

	// Create test file in source
	testFile := filepath.Join(srcDir, "test.txt")
	testContent := []byte("hello world")
	if err := os.WriteFile(testFile, testContent, 0644); err != nil {
		t.Fatalf("Failed to write test file: %v", err)
	}

	// Mount in overlay mode
	if err := Mount(srcDir, targetDir, "overlay", st); err != nil {
		t.Fatalf("Mount failed: %v", err)
	}

	// Verify can read file from target
	targetFile := filepath.Join(targetDir, "test.txt")
	content, err := os.ReadFile(targetFile)
	if err != nil {
		t.Errorf("Failed to read file from target: %v", err)
	}
	if string(content) != string(testContent) {
		t.Errorf("Content mismatch: got %q, want %q", content, testContent)
	}

	// Write new file to target
	newFile := filepath.Join(targetDir, "new.txt")
	newContent := []byte("new content")
	if err := os.WriteFile(newFile, newContent, 0644); err != nil {
		t.Errorf("Failed to write new file to target: %v", err)
	}

	// Verify file does NOT appear in source (isolated)
	sourceNewFile := filepath.Join(srcDir, "new.txt")
	if _, err := os.Stat(sourceNewFile); err == nil {
		t.Error("File written to overlay target should not appear in source")
	} else if !os.IsNotExist(err) {
		t.Errorf("Unexpected error checking source: %v", err)
	}

	// Get mount info to check temp dir
	info, err := st.GetMount(targetDir)
	if err != nil {
		t.Fatalf("Failed to get mount info: %v", err)
	}
	if info.TempDir == "" {
		t.Error("Overlay mount should have TempDir set")
	}
	tempDir := info.TempDir

	// Verify temp dir exists
	if _, err := os.Stat(tempDir); err != nil {
		t.Errorf("Temp directory should exist: %v", err)
	}

	// Unmount
	if err := Unmount(targetDir, st); err != nil {
		t.Errorf("Unmount failed: %v", err)
	}

	// Verify temp dir is cleaned up
	if _, err := os.Stat(tempDir); err == nil {
		t.Error("Temp directory should be removed after unmount")
	} else if !os.IsNotExist(err) {
		t.Errorf("Unexpected error checking temp dir: %v", err)
	}

	// Verify mount removed from state
	if st.MountExists(targetDir) {
		t.Error("Mount still exists in state after unmount")
	}
}

// TestMountSourceNotExists tests error when source doesn't exist.
func TestMountSourceNotExists(t *testing.T) {
	skipIfDepsNotInstalled(t)

	_, targetDir, st, cleanup := setupTestDirs(t)
	defer cleanup()

	nonExistentSource := "/nonexistent/path/that/does/not/exist"

	err := Mount(nonExistentSource, targetDir, "ro", st)
	if err == nil {
		t.Error("Expected error when mounting non-existent source")
	}

	// Verify error message mentions source doesn't exist
	if err != nil && !strings.Contains(err.Error(), "source directory does not exist") {
		t.Errorf("Expected 'source directory does not exist' error, got: %v", err)
	}
}

// TestMountTargetAlreadyMounted tests error when target is already mounted.
func TestMountTargetAlreadyMounted(t *testing.T) {
	skipIfDepsNotInstalled(t)

	srcDir, targetDir, st, cleanup := setupTestDirs(t)
	defer cleanup()

	// Create test file
	if err := os.WriteFile(filepath.Join(srcDir, "test.txt"), []byte("test"), 0644); err != nil {
		t.Fatalf("Failed to write test file: %v", err)
	}

	// First mount should succeed
	if err := Mount(srcDir, targetDir, "ro", st); err != nil {
		t.Fatalf("First mount failed: %v", err)
	}

	// Second mount should fail
	err := Mount(srcDir, targetDir, "ro", st)
	if err == nil {
		t.Error("Expected error when mounting already mounted target")
	}

	// Verify error message mentions already mounted
	if err != nil && !strings.Contains(err.Error(), "already mounted") {
		t.Errorf("Expected 'already mounted' error, got: %v", err)
	}

	// Cleanup: unmount
	if err := Unmount(targetDir, st); err != nil {
		t.Errorf("Cleanup unmount failed: %v", err)
	}
}

// TestUnmountNotMounted tests error when trying to unmount a path that isn't mounted.
func TestUnmountNotMounted(t *testing.T) {
	skipIfDepsNotInstalled(t)

	_, targetDir, st, cleanup := setupTestDirs(t)
	defer cleanup()

	err := Unmount(targetDir, st)
	if err == nil {
		t.Error("Expected error when unmounting path that isn't mounted")
	}

	// Verify error message mentions not mounted
	if err != nil && !strings.Contains(err.Error(), "not mounted") {
		t.Errorf("Expected 'not mounted' error, got: %v", err)
	}
}
