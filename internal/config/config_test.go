package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/basedir"
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

	expected, err := basedir.New("").AmikaStateDir()
	if err != nil {
		t.Fatalf("AmikaStateDir() error: %v", err)
	}
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

func TestStateDir_XDGOverride(t *testing.T) {
	customState := filepath.Join(t.TempDir(), "xdg-state")
	origState, hadState := os.LookupEnv("XDG_STATE_HOME")
	origOverride, hadOverride := os.LookupEnv(EnvStateDirectory)
	_ = os.Unsetenv(EnvStateDirectory)
	_ = os.Setenv("XDG_STATE_HOME", customState)
	t.Cleanup(func() {
		if hadState {
			_ = os.Setenv("XDG_STATE_HOME", origState)
		} else {
			_ = os.Unsetenv("XDG_STATE_HOME")
		}
		if hadOverride {
			_ = os.Setenv(EnvStateDirectory, origOverride)
		} else {
			_ = os.Unsetenv(EnvStateDirectory)
		}
	})

	dir, err := StateDir()
	if err != nil {
		t.Fatalf("StateDir() error: %v", err)
	}

	want := filepath.Join(customState, "amika")
	if dir != want {
		t.Errorf("StateDir() = %q, want %q", dir, want)
	}
}

func TestMountsStateFile_Default(t *testing.T) {
	orig := os.Getenv(EnvStateDirectory)
	_ = os.Unsetenv(EnvStateDirectory)
	defer func() {
		if orig != "" {
			_ = os.Setenv(EnvStateDirectory, orig)
		}
	}()

	got, err := MountsStateFile()
	if err != nil {
		t.Fatalf("MountsStateFile() error: %v", err)
	}

	want, err := basedir.New("").MountsStateFile()
	if err != nil {
		t.Fatalf("basedir MountsStateFile() error: %v", err)
	}
	if got != want {
		t.Errorf("MountsStateFile() = %q, want %q", got, want)
	}
}

func TestMountsStateFile_EnvOverride(t *testing.T) {
	override := t.TempDir()
	orig := os.Getenv(EnvStateDirectory)
	_ = os.Setenv(EnvStateDirectory, override)
	defer func() {
		if orig != "" {
			_ = os.Setenv(EnvStateDirectory, orig)
		} else {
			_ = os.Unsetenv(EnvStateDirectory)
		}
	}()

	got, err := MountsStateFile()
	if err != nil {
		t.Fatalf("MountsStateFile() error: %v", err)
	}
	want := basedir.MountsStateFileIn(override)
	if got != want {
		t.Errorf("MountsStateFile() = %q, want %q", got, want)
	}
}

func TestSandboxesStateFile_Default(t *testing.T) {
	orig := os.Getenv(EnvStateDirectory)
	_ = os.Unsetenv(EnvStateDirectory)
	defer func() {
		if orig != "" {
			_ = os.Setenv(EnvStateDirectory, orig)
		}
	}()

	got, err := SandboxesStateFile()
	if err != nil {
		t.Fatalf("SandboxesStateFile() error: %v", err)
	}

	want, err := basedir.New("").SandboxesStateFile()
	if err != nil {
		t.Fatalf("basedir SandboxesStateFile() error: %v", err)
	}
	if got != want {
		t.Errorf("SandboxesStateFile() = %q, want %q", got, want)
	}
}

func TestSandboxesStateFile_EnvOverride(t *testing.T) {
	override := t.TempDir()
	orig := os.Getenv(EnvStateDirectory)
	_ = os.Setenv(EnvStateDirectory, override)
	defer func() {
		if orig != "" {
			_ = os.Setenv(EnvStateDirectory, orig)
		} else {
			_ = os.Unsetenv(EnvStateDirectory)
		}
	}()

	got, err := SandboxesStateFile()
	if err != nil {
		t.Fatalf("SandboxesStateFile() error: %v", err)
	}
	want := basedir.SandboxesStateFileIn(override)
	if got != want {
		t.Errorf("SandboxesStateFile() = %q, want %q", got, want)
	}
}
