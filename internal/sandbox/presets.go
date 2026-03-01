package sandbox

import (
	"embed"
	"fmt"
)

//go:embed presets/*/Dockerfile
var presetFS embed.FS

func normalizePresetName(name string) string {
	switch name {
	case "claude":
		return "coder"
	default:
		return name
	}
}

// GetPresetDockerfile returns the Dockerfile content for the given preset name.
func GetPresetDockerfile(name string) ([]byte, error) {
	presetName := normalizePresetName(name)
	data, err := presetFS.ReadFile("presets/" + presetName + "/Dockerfile")
	if err != nil {
		return nil, fmt.Errorf("unknown preset %q", name)
	}
	return data, nil
}
