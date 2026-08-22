// Package amikalyze implements experimental frozen-path policy for coding
// agent file edits.
package amikalyze

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/BurntSushi/toml"
)

const configName = ".amikalyze.toml"

// Config is one .amikalyze.toml document.
type Config struct {
	Freezes []Freeze `toml:"freezes"`
}

// Freeze groups frozen path patterns under a label that can be selectively
// disabled for one `amikalyze run` child process.
type Freeze struct {
	Label string   `toml:"label"`
	Paths []string `toml:"paths"`
}

type loadedConfig struct {
	path   string
	dir    string
	config Config
}

func loadConfig(filename string) (loadedConfig, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return loadedConfig{}, fmt.Errorf("reading %s: %w", filename, err)
	}
	var config Config
	metadata, err := toml.Decode(string(data), &config)
	if err != nil {
		return loadedConfig{}, fmt.Errorf("parsing %s: %w", filename, err)
	}
	if undecoded := metadata.Undecoded(); len(undecoded) > 0 {
		return loadedConfig{}, fmt.Errorf("parsing %s: unknown key %q", filename, undecoded[0].String())
	}
	if err := validateConfig(config); err != nil {
		return loadedConfig{}, fmt.Errorf("validating %s: %w", filename, err)
	}
	return loadedConfig{path: filename, dir: filepath.Dir(filename), config: config}, nil
}

func validateConfig(config Config) error {
	labels := make(map[string]struct{}, len(config.Freezes))
	for i, freeze := range config.Freezes {
		if err := validateLabel(freeze.Label); err != nil {
			return fmt.Errorf("freezes[%d].label: %w", i, err)
		}
		if _, exists := labels[freeze.Label]; exists {
			return fmt.Errorf("duplicate freeze label %q", freeze.Label)
		}
		labels[freeze.Label] = struct{}{}
		if len(freeze.Paths) == 0 {
			return fmt.Errorf("freeze %q must contain at least one path", freeze.Label)
		}
		for j, pattern := range freeze.Paths {
			if err := validatePattern(pattern); err != nil {
				return fmt.Errorf("freeze %q paths[%d]: %w", freeze.Label, j, err)
			}
		}
	}
	return nil
}

func validateLabel(label string) error {
	if label == "" {
		return errors.New("must not be empty")
	}
	for _, r := range label {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '_' || r == '-' || r == '/' {
			continue
		}
		return fmt.Errorf("%q contains invalid character %q", label, r)
	}
	return nil
}

func validatePattern(pattern string) error {
	if pattern == "" {
		return errors.New("must not be empty")
	}
	if strings.Contains(pattern, "\\") {
		return errors.New("must use forward slashes")
	}
	if path.IsAbs(pattern) || filepath.IsAbs(pattern) || filepath.VolumeName(pattern) != "" {
		return errors.New("must be relative to the config directory")
	}
	segments := strings.Split(pattern, "/")
	for _, segment := range segments {
		switch {
		case segment == "":
			return errors.New("must not contain empty path segments")
		case segment == "..":
			return errors.New("must not contain .. path segments")
		case strings.Contains(segment, "**") && segment != "**":
			return errors.New("** must occupy an entire path segment")
		case segment != "**":
			if _, err := path.Match(segment, ""); err != nil {
				return fmt.Errorf("invalid glob: %w", err)
			}
		}
	}
	return nil
}
