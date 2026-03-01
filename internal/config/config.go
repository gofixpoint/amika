// Package config provides configuration and path resolution for amika.
package config

import (
	"os"

	"github.com/gofixpoint/amika/internal/basedir"
)

const (
	// EnvStateDirectory is the environment variable that overrides the default state directory.
	EnvStateDirectory = "AMIKA_STATE_DIRECTORY"
)

// StateDir returns the resolved amika state directory path.
// It checks AMIKA_STATE_DIRECTORY first, falling back to XDG_STATE_HOME/amika
// (or ~/.local/state/amika when XDG_STATE_HOME is unset).
func StateDir() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return dir, nil
	}
	return basedir.New("").AmikaStateDir()
}

// MountsStateFile returns the resolved mounts state file path.
func MountsStateFile() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.MountsStateFileIn(dir), nil
	}
	return basedir.New("").MountsStateFile()
}

// SandboxesStateFile returns the resolved sandboxes state file path.
func SandboxesStateFile() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.SandboxesStateFileIn(dir), nil
	}
	return basedir.New("").SandboxesStateFile()
}

// VolumesStateFile returns the resolved volumes state file path.
func VolumesStateFile() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.VolumesStateFileIn(dir), nil
	}
	return basedir.New("").VolumesStateFile()
}
