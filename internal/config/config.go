package config

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	// DefaultStateDir is the default state directory relative to the user's home directory.
	DefaultStateDir = ".local/state/amika"

	// EnvStateDirectory is the environment variable that overrides the default state directory.
	EnvStateDirectory = "AMIKA_STATE_DIRECTORY"
)

// StateDir returns the resolved amika state directory path.
// It checks AMIKA_STATE_DIRECTORY first, falling back to ~/.local/state/amika.
func StateDir() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	return filepath.Join(home, DefaultStateDir), nil
}
