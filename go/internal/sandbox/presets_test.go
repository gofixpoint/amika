package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGetPresetDockerfile_ReturnsGeneratedPresets(t *testing.T) {
	for _, preset := range AllowedPresets {
		data, err := GetPresetDockerfile(preset)
		if err != nil {
			t.Fatalf("unexpected error for %s: %v", preset, err)
		}
		content := string(data)
		if !strings.Contains(content, "COPY sandbox-image/steps/") {
			t.Fatalf("%s does not use the shared bundle", preset)
		}
		if strings.Contains(content, "ENTRYPOINT") || strings.Contains(content, "CMD") {
			t.Fatalf("%s should leave lifecycle metadata to the runtime", preset)
		}
	}
}

func TestGetPresetDockerfile_UnknownPresetErrors(t *testing.T) {
	data, err := GetPresetDockerfile("missing-preset")
	if err == nil {
		t.Fatal("expected error for unknown preset")
	}
	if len(data) != 0 {
		t.Fatal("expected empty data for unknown preset")
	}
}

func TestWritePresetBuildContext_ExtractsBundle(t *testing.T) {
	contextDir, cleanup, err := WritePresetBuildContext("coder")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer cleanup()

	for _, relPath := range []string{
		filepath.Join("sandbox-image", "manifest.toml"),
		filepath.Join("sandbox-image", "versions.env"),
		filepath.Join("sandbox-image", "assets", "stable", ".zshrc"),
		filepath.Join("sandbox-image", "generated", "coder.Dockerfile"),
		filepath.Join("sandbox-image", "generated", "coder-dind.Dockerfile"),
		filepath.Join("sandbox-image", "steps", "10-os-packages.sh"),
		filepath.Join("sandbox-image", "verify", "run.sh"),
	} {
		data, err := os.ReadFile(filepath.Join(contextDir, relPath))
		if err != nil {
			t.Fatalf("failed to read %s from context dir: %v", relPath, err)
		}
		if len(data) == 0 {
			t.Fatalf("expected non-empty %s", relPath)
		}
	}
}

func TestWritePresetBuildContext_MakesScriptsExecutable(t *testing.T) {
	contextDir, cleanup, err := WritePresetBuildContext("coder")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer cleanup()

	path := filepath.Join(contextDir, "sandbox-image", "steps", "10-os-packages.sh")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0755 {
		t.Fatalf("script mode = %o, want 755", info.Mode().Perm())
	}
}

func TestWritePresetBuildContext_UnknownPresetErrors(t *testing.T) {
	_, _, err := WritePresetBuildContext("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown preset")
	}
}
