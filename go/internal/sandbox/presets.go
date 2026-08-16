package sandbox

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:sandbox-image
var sandboxImageFS embed.FS

// GetPresetDockerfile returns the Dockerfile content for the given preset name.
func GetPresetDockerfile(name string) ([]byte, error) {
	data, err := sandboxImageFS.ReadFile("sandbox-image/generated/" + name + ".Dockerfile")
	if err != nil {
		return nil, fmt.Errorf("unknown preset %q", name)
	}
	return data, nil
}

// WritePresetBuildContext extracts the embedded sandbox image bundle to a temp
// directory and returns the path along with a cleanup function. The context
// contains sandbox-image/ at its root, matching the generated Dockerfiles.
func WritePresetBuildContext(preset string) (contextDir string, cleanup func(), err error) {
	if _, readErr := GetPresetDockerfile(preset); readErr != nil {
		return "", nil, fmt.Errorf("unknown preset %q", preset)
	}

	tmpDir, err := os.MkdirTemp("", "amika-build-context-*")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create build context dir: %w", err)
	}
	cleanup = func() { os.RemoveAll(tmpDir) }

	err = fs.WalkDir(sandboxImageFS, "sandbox-image", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		dest := filepath.Join(tmpDir, filepath.FromSlash(path))

		if d.IsDir() {
			return os.MkdirAll(dest, 0755)
		}

		data, readErr := sandboxImageFS.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		return os.WriteFile(dest, data, embeddedBuildContextMode(path))
	})
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("failed to extract build context: %w", err)
	}

	return tmpDir, cleanup, nil
}

func embeddedBuildContextMode(path string) fs.FileMode {
	if strings.HasSuffix(path, ".sh") || strings.HasSuffix(path, ".py") {
		return 0755
	}
	return 0644
}
