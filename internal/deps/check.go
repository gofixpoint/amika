package deps

import (
	"fmt"
	"os"
	"os/exec"
)

// DependencyError represents a missing dependency with installation instructions.
type DependencyError struct {
	Name         string
	Instructions string
}

func (e *DependencyError) Error() string {
	return fmt.Sprintf("%s is not installed.\n\n%s", e.Name, e.Instructions)
}

// CheckBindfs verifies that bindfs is installed and available in PATH.
func CheckBindfs() error {
	_, err := exec.LookPath("bindfs")
	if err != nil {
		return &DependencyError{
			Name:         "bindfs",
			Instructions: "Install bindfs using Homebrew:\n  brew install bindfs",
		}
	}
	return nil
}

// CheckMacFUSE verifies that macFUSE is installed.
func CheckMacFUSE() error {
	// Check for macFUSE filesystem bundle
	paths := []string{
		"/Library/Filesystems/macfuse.fs",
		"/Library/Filesystems/osxfuse.fs", // Older name
	}

	for _, path := range paths {
		if _, err := os.Stat(path); err == nil {
			return nil
		}
	}

	return &DependencyError{
		Name:         "macFUSE",
		Instructions: "Install macFUSE from: https://osxfuse.github.io/\n\nOr install via Homebrew:\n  brew install --cask macfuse",
	}
}

// CheckAll verifies all required dependencies are installed.
// Returns an error describing the first missing dependency found.
func CheckAll() error {
	if err := CheckMacFUSE(); err != nil {
		return err
	}
	if err := CheckBindfs(); err != nil {
		return err
	}
	return nil
}
