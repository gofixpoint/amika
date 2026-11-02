package amikad

import (
	"path/filepath"
	"testing"
)

// realTempDir is t.TempDir with symlinks resolved. On macOS the temp
// directory sits under /var, a symlink to /private/var, and amikad's secure
// writes refuse any symlink in a path, so tests must use the real one.
func realTempDir(t *testing.T) string {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return directory
}
