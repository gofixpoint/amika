package sandbox

import (
	"embed"
	"fmt"
)

//go:embed presets/*/Dockerfile
var presetFS embed.FS

// GetPresetDockerfile returns the Dockerfile content for the given preset name.
func GetPresetDockerfile(name string) ([]byte, error) {
	data, err := presetFS.ReadFile("presets/" + name + "/Dockerfile")
	if err != nil {
		return nil, fmt.Errorf("unknown preset %q", name)
	}
	return data, nil
}
