package sandbox

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

//go:embed all:presets
var presetFS embed.FS

// GetPresetDockerfile returns the Dockerfile content for the given preset name.
func GetPresetDockerfile(name string) ([]byte, error) {
	data, err := presetFS.ReadFile("presets/" + name + "/Dockerfile")
	if err != nil {
		return nil, fmt.Errorf("unknown preset %q", name)
	}
	return data, nil
}

// WritePresetBuildContext extracts the embedded presets/ tree to a temp directory
// and returns the path along with a cleanup function. The temp dir layout mirrors
// the embed tree (e.g. .zshrc, claude/Dockerfile, coder/Dockerfile).
func WritePresetBuildContext(preset string) (contextDir string, cleanup func(), err error) {
	// Verify the preset exists before creating temp dir.
	_, readErr := presetFS.ReadFile("presets/" + preset + "/Dockerfile")
	if readErr != nil {
		return "", nil, fmt.Errorf("unknown preset %q", preset)
	}

	tmpDir, err := os.MkdirTemp("", "amika-build-context-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create build context dir: %w", err)
	}
	cleanup = func() { os.RemoveAll(tmpDir) }

	// Walk the embedded presets/ tree and write all files to tmpDir.
	err = fs.WalkDir(presetFS, "presets", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		// Strip the "presets/" prefix to get the relative path within the context dir.
		rel, relErr := filepath.Rel("presets", path)
		if relErr != nil {
			return relErr
		}
		dest := filepath.Join(tmpDir, rel)

		if d.IsDir() {
			return os.MkdirAll(dest, 0755)
		}

		data, readErr := presetFS.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		return os.WriteFile(dest, data, 0644)
	})
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to extract build context: %w", err)
	}

	return tmpDir, cleanup, nil
}
