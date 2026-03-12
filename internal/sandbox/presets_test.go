package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGetPresetDockerfile_ReturnsDockerfilesForKnownPresets(t *testing.T) {
	for _, preset := range []string{"base", "coder", "claude", "daytona-coder", "daytona-claude"} {
		data, err := GetPresetDockerfile(preset)
		if err != nil {
			t.Fatalf("unexpected error for %s: %v", preset, err)
		}
		if len(data) == 0 {
			t.Fatalf("expected non-empty Dockerfile for %s", preset)
		}
	}
}

func TestGetPresetDockerfile_PreservesAgentCWDForPreSetup(t *testing.T) {
	for _, preset := range []string{"coder", "claude"} {
		data, err := GetPresetDockerfile(preset)
		if err != nil {
			t.Fatalf("unexpected error loading %s preset: %v", preset, err)
		}
		content := string(data)
		if !strings.Contains(content, `sudo AMIKA_AGENT_CWD=`) || !strings.Contains(content, `/usr/lib/amikad/pre-setup.sh`) {
			t.Fatalf("%s Dockerfile does not preserve AMIKA_AGENT_CWD for pre-setup", preset)
		}
	}
}

func TestGetPresetDockerfile_PreservesOpenCodeEnvForPreSetup(t *testing.T) {
	for _, preset := range []string{"coder", "claude"} {
		data, err := GetPresetDockerfile(preset)
		if err != nil {
			t.Fatalf("unexpected error loading %s preset: %v", preset, err)
		}
		content := string(data)
		if !strings.Contains(content, `AMIKA_OPENCODE_WEB=\"$AMIKA_OPENCODE_WEB\"`) {
			t.Fatalf("%s Dockerfile does not preserve AMIKA_OPENCODE_WEB for pre-setup", preset)
		}
		if !strings.Contains(content, `OPENCODE_SERVER_PASSWORD=\"$OPENCODE_SERVER_PASSWORD\"`) {
			t.Fatalf("%s Dockerfile does not preserve OPENCODE_SERVER_PASSWORD for pre-setup", preset)
		}
	}
}

func TestGetPresetDockerfile_BaseCreatesAmikaAndAmikadDirectories(t *testing.T) {
	data, err := GetPresetDockerfile("base")
	if err != nil {
		t.Fatalf("unexpected error loading base preset: %v", err)
	}

	content := string(data)
	for _, want := range []string{
		"/var/log/amikad /var/log/amika",
		"/usr/lib/amikad /usr/lib/amika",
		"/run/amikad /run/amika",
		"/usr/local/etc/amikad /usr/local/etc/amika",
		"/var/lib/amikad /var/lib/amika",
		"/tmp/amikad /tmp/amika",
	} {
		if !strings.Contains(content, want) {
			t.Fatalf("base Dockerfile missing paired amika/amikad directories %q", want)
		}
	}
}

func TestGetPresetDockerfile_DaytonaVariantsClearEntrypoint(t *testing.T) {
	for _, preset := range []string{"daytona-coder", "daytona-claude"} {
		data, err := GetPresetDockerfile(preset)
		if err != nil {
			t.Fatalf("unexpected error loading %s preset: %v", preset, err)
		}
		content := string(data)
		if !strings.Contains(content, "ENTRYPOINT []") {
			t.Fatalf("%s Dockerfile does not clear the inherited entrypoint", preset)
		}
		if strings.Contains(content, "/usr/local/etc/amikad/setup/setup.sh") || strings.Contains(content, "/usr/lib/amikad/pre-setup.sh") {
			t.Fatalf("%s Dockerfile should not invoke Amika setup hooks", preset)
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

	for _, relPath := range []string{
		filepath.Join("base", "Dockerfile"),
		filepath.Join("coder", "Dockerfile"),
		filepath.Join("claude", "Dockerfile"),
		filepath.Join("daytona-coder", "Dockerfile"),
		filepath.Join("daytona-claude", "Dockerfile"),
	} {
		data, err = os.ReadFile(filepath.Join(contextDir, relPath))
		if err != nil {
			t.Fatalf("failed to read %s from context dir: %v", relPath, err)
		}
		if len(data) == 0 {
			t.Fatalf("expected non-empty %s", relPath)
		}
	}
}

func TestWritePresetBuildContext_UnknownPresetErrors(t *testing.T) {
	_, _, err := WritePresetBuildContext("nonexistent")
	if err == nil {
		t.Fatal("expected error for unknown preset")
	}
}
