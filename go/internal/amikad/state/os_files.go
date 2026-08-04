package state

import (
	"io/fs"
	"os"
)

// OSFiles atomically replaces files on the host filesystem.
type OSFiles struct{}

// ReadFile reads a complete file.
func (OSFiles) ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }

// Lstat reads metadata without following the final symlink.
func (OSFiles) Lstat(path string) (fs.FileInfo, error) { return os.Lstat(path) }
