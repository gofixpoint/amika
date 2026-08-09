package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/basedir"
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

func TestVolumesStateFile_Default(t *testing.T) {
	orig := os.Getenv(EnvStateDirectory)
	_ = os.Unsetenv(EnvStateDirectory)
	defer func() {
		if orig != "" {
			_ = os.Setenv(EnvStateDirectory, orig)
		}
	}()

	got, err := VolumesStateFile()
	if err != nil {
		t.Fatalf("VolumesStateFile() error: %v", err)
	}

	want, err := basedir.New("").VolumesStateFile()
	if err != nil {
		t.Fatalf("basedir VolumesStateFile() error: %v", err)
	}
	if got != want {
		t.Errorf("VolumesStateFile() = %q, want %q", got, want)
	}
}

func TestVolumesStateFile_EnvOverride(t *testing.T) {
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

	got, err := VolumesStateFile()
	if err != nil {
		t.Fatalf("VolumesStateFile() error: %v", err)
	}
	want := basedir.VolumesStateFileIn(override)
	if got != want {
		t.Errorf("VolumesStateFile() = %q, want %q", got, want)
	}
}

func TestEnvironmentSlugFoldsHostAndPortIntoOneAliasSegment(t *testing.T) {
	for _, tc := range []struct {
		apiURL string
		want   string
	}{
		{"http://localhost:3011", "localhost-3011"},
		{"https://app.staging-amika.dev", "app-staging-amika-dev"},
		{"https://app.amika.dev", "app-amika-dev"},
		{"https://APP.Amika.Dev", "app-amika-dev"},
		{"http://127.0.0.1:8080/some/path", "127-0-0-1-8080"},
	} {
		got, err := environmentSlugFor(tc.apiURL)
		if err != nil {
			t.Errorf("environmentSlugFor(%q): %v", tc.apiURL, err)
			continue
		}
		if got != tc.want {
			t.Errorf("environmentSlugFor(%q) = %q, want %q", tc.apiURL, got, tc.want)
		}
	}
}

// The slug becomes one dot-separated segment of an SSH host alias, so it must
// never itself contain a dot or the alias would parse with shifted fields.
func TestEnvironmentSlugNeverContainsADot(t *testing.T) {
	slug, err := environmentSlugFor("https://a.b.c.d.example.com:9999")
	if err != nil {
		t.Fatalf("environmentSlugFor: %v", err)
	}
	if strings.Contains(slug, ".") {
		t.Fatalf("slug %q contains a dot", slug)
	}
}

func TestEnvironmentSlugRejectsURLsWithoutAHost(t *testing.T) {
	for _, apiURL := range []string{"", "not-a-url", "/just/a/path"} {
		if _, err := environmentSlugFor(apiURL); err == nil {
			t.Errorf("environmentSlugFor(%q) was accepted", apiURL)
		}
	}
}

func TestBinaryPathDefaultsToTheRunningExecutable(t *testing.T) {
	t.Setenv(EnvBinaryPath, "")

	got, err := BinaryPath()
	if err != nil {
		t.Fatalf("BinaryPath: %v", err)
	}
	want, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if got != want {
		t.Errorf("BinaryPath() = %q, want %q", got, want)
	}
}

// The override exists so a wrapper script can name itself: os.Executable
// resolves to the real binary and cannot see the wrapper that exported the
// environment amika needs.
func TestBinaryPathHonorsTheOverride(t *testing.T) {
	wrapper := filepath.Join(t.TempDir(), "amika-local")
	if err := os.WriteFile(wrapper, []byte("#!/bin/bash\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvBinaryPath, wrapper)

	got, err := BinaryPath()
	if err != nil {
		t.Fatalf("BinaryPath: %v", err)
	}
	if got != wrapper {
		t.Errorf("BinaryPath() = %q, want %q", got, wrapper)
	}
}

// An unusable override is an error rather than a silent fallback: the value is
// written into a config file that has to work later, so a typo must surface at
// the command that set it, not as an opaque connection failure.
func TestBinaryPathRejectsAnUnusableOverride(t *testing.T) {
	dir := t.TempDir()
	for name, override := range map[string]string{
		"relative": "bin/amika",
		"missing":  filepath.Join(dir, "does-not-exist"),
		"director": dir,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(EnvBinaryPath, override)
			if _, err := BinaryPath(); err == nil {
				t.Errorf("BinaryPath() accepted %q", override)
			}
		})
	}
}
