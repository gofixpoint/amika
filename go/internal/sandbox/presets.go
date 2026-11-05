package sandbox

import (
	"embed"
	"fmt"
	"strings"
)

// sandboxImageFS is the sandbox image bundle compiled into the binary. The
// CLI reads the amika-cli agent skill from it (see AgentSkillFS).
//
//go:embed all:sandbox-image
var sandboxImageFS embed.FS

// RemotePresets lists the presets a rig can name. macos-coder runs only on a
// host with a macOS runtime (Lume).
var RemotePresets = []string{"coder", "coder-plus-docker", "macos-coder"}

// ValidateRemotePreset returns an error if preset is non-empty and not in
// RemotePresets.
func ValidateRemotePreset(preset string) error {
	if preset == "" {
		return nil
	}
	for _, p := range RemotePresets {
		if preset == p {
			return nil
		}
	}
	return fmt.Errorf("unknown preset %q; allowed presets: %s", preset, strings.Join(RemotePresets, ", "))
}
