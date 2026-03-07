// Package amikaconfig loads per-repo Amika configuration from .amika/config.toml.
package amikaconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Config is the parsed .amika/config.toml file.
type Config struct {
	Lifecycle LifecycleConfig `toml:"lifecycle"`
}

// LifecycleConfig holds sandbox lifecycle hooks.
type LifecycleConfig struct {
	// SetupScript is the path to an executable to mount at /opt/setup.sh.
	// Relative paths are resolved from the repo root.
	SetupScript string `toml:"setup_script"`
}

// LoadConfig reads $repoRoot/.amika/config.toml.
// Returns nil, nil if the file does not exist.
func LoadConfig(repoRoot string) (*Config, error) {
	path := filepath.Join(repoRoot, ".amika", "config.toml")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return &cfg, nil
}
