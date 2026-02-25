package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateDir_Default(t *testing.T) {
	// Unset the env var to test default behavior
	orig := os.Getenv(EnvStateDirectory)
	os.Unsetenv(EnvStateDirectory)
	defer func() {
		if orig != "" {
			os.Setenv(EnvStateDirectory, orig)
		}
	}()

	dir, err := StateDir()
	if err != nil {
		t.Fatalf("StateDir() error: %v", err)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir() error: %v", err)
	}

	expected := filepath.Join(home, DefaultStateDir)
	if dir != expected {
		t.Errorf("StateDir() = %q, want %q", dir, expected)
	}
}

func TestStateDir_EnvOverride(t *testing.T) {
	override := "/tmp/custom-amika-state"

	orig := os.Getenv(EnvStateDirectory)
	os.Setenv(EnvStateDirectory, override)
	defer func() {
		if orig != "" {
			os.Setenv(EnvStateDirectory, orig)
		} else {
			os.Unsetenv(EnvStateDirectory)
		}
	}()

	dir, err := StateDir()
	if err != nil {
		t.Fatalf("StateDir() error: %v", err)
	}

	if dir != override {
		t.Errorf("StateDir() = %q, want %q", dir, override)
	}
}
