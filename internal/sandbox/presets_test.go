package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetPresetDockerfile_CoderReturnsDockerfile(t *testing.T) {
	data, err := GetPresetDockerfile("coder")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("expected non-empty Dockerfile")
	}
}

func TestGetPresetDockerfile_ClaudeReturnsDockerfile(t *testing.T) {
	data, err := GetPresetDockerfile("claude")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("expected non-empty Dockerfile")
	}
}

func TestGetPresetDockerfile_CoderAndClaudeDiffer(t *testing.T) {
	coderData, err := GetPresetDockerfile("coder")
	if err != nil {
		t.Fatalf("unexpected error loading coder preset: %v", err)
	}
	claudeData, err := GetPresetDockerfile("claude")
	if err != nil {
		t.Fatalf("unexpected error loading claude preset: %v", err)
	}
	if string(coderData) == string(claudeData) {
		t.Fatal("expected coder and claude Dockerfiles to differ")
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

func TestWritePresetBuildContext_ExtractsZshrc(t *testing.T) {
	contextDir, cleanup, err := WritePresetBuildContext("coder")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer cleanup()

	// Verify .zshrc exists at the root of the context dir.
	zshrcPath := filepath.Join(contextDir, ".zshrc")
	data, err := os.ReadFile(zshrcPath)
	if err != nil {
		t.Fatalf("failed to read .zshrc from context dir: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("expected non-empty .zshrc")
	}

	// Verify the preset Dockerfile exists.
	dockerfilePath := filepath.Join(contextDir, "coder", "Dockerfile")
	data, err = os.ReadFile(dockerfilePath)
	if err != nil {
		t.Fatalf("failed to read coder/Dockerfile from context dir: %v", err)
	}
	if len(data) == 0 {
		t.Fatal("expected non-empty coder/Dockerfile")
	}
}

func TestWritePresetBuildContext_UnknownPresetErrors(t *testing.T) {
	_, _, err := WritePresetBuildContext("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown preset")
	}
}
