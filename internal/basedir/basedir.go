// Package basedir resolves XDG base directories and Amika-managed file paths.
package basedir

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	appName          = "amika"
	envCacheFile     = "env-cache.json"
	keychainFile     = "keychain.json"
	oauthFile        = "oauth.json"
	mountsStateFile  = "mounts.jsonl"
	sandboxesFile    = "sandboxes.jsonl"
	volumesStateFile = "volumes.jsonl"
	envXDGConfigHome = "XDG_CONFIG_HOME"
	envXDGDataHome   = "XDG_DATA_HOME"
	envXDGCacheHome  = "XDG_CACHE_HOME"
	envXDGStateHome  = "XDG_STATE_HOME"
)

// Paths resolves XDG base directories and Amika-managed file locations.
type Paths interface {
	HomeDir() (string, error)
	ConfigHome() (string, error)
	DataHome() (string, error)
	CacheHome() (string, error)
	StateHome() (string, error)

	AmikaConfigDir() (string, error)
	AmikaDataDir() (string, error)
	AmikaCacheDir() (string, error)
	AmikaStateDir() (string, error)

	AuthEnvCacheFile() (string, error)
	AuthKeychainFile() (string, error)
	AuthOAuthFile() (string, error)
	MountsStateFile() (string, error)
	SandboxesStateFile() (string, error)
	VolumesStateFile() (string, error)
}

type xdgPaths struct {
	homeOverride string
}

// New returns a Paths resolver. If homeOverride is non-empty, XDG fallback
// directories are resolved relative to that home directory.
func New(homeOverride string) Paths {
	return &xdgPaths{homeOverride: homeOverride}
}

func (p *xdgPaths) HomeDir() (string, error) {
	if p.homeOverride != "" {
		return p.homeOverride, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	return home, nil
}

func (p *xdgPaths) ConfigHome() (string, error) {
	if v := os.Getenv(envXDGConfigHome); v != "" {
		return v, nil
	}
	home, err := p.HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config"), nil
}

func (p *xdgPaths) DataHome() (string, error) {
	if v := os.Getenv(envXDGDataHome); v != "" {
		return v, nil
	}
	home, err := p.HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share"), nil
}

func (p *xdgPaths) CacheHome() (string, error) {
	if v := os.Getenv(envXDGCacheHome); v != "" {
		return v, nil
	}
	home, err := p.HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cache"), nil
}

func (p *xdgPaths) StateHome() (string, error) {
	if v := os.Getenv(envXDGStateHome); v != "" {
		return v, nil
	}
	home, err := p.HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state"), nil
}

func (p *xdgPaths) AmikaConfigDir() (string, error) {
	base, err := p.ConfigHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, appName), nil
}

func (p *xdgPaths) AmikaDataDir() (string, error) {
	base, err := p.DataHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, appName), nil
}

func (p *xdgPaths) AmikaCacheDir() (string, error) {
	base, err := p.CacheHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, appName), nil
}

func (p *xdgPaths) AmikaStateDir() (string, error) {
	base, err := p.StateHome()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, appName), nil
}

func (p *xdgPaths) AuthEnvCacheFile() (string, error) {
	dir, err := p.AmikaCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, envCacheFile), nil
}

func (p *xdgPaths) AuthKeychainFile() (string, error) {
	dir, err := p.AmikaDataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, keychainFile), nil
}

func (p *xdgPaths) AuthOAuthFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, oauthFile), nil
}

func (p *xdgPaths) MountsStateFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return MountsStateFileIn(dir), nil
}

func (p *xdgPaths) SandboxesStateFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return SandboxesStateFileIn(dir), nil
}

func (p *xdgPaths) VolumesStateFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return VolumesStateFileIn(dir), nil
}

// MountsStateFileIn returns the mounts state file path under the given state directory.
func MountsStateFileIn(stateDir string) string {
	return filepath.Join(stateDir, mountsStateFile)
}

// SandboxesStateFileIn returns the sandboxes state file path under the given state directory.
func SandboxesStateFileIn(stateDir string) string {
	return filepath.Join(stateDir, sandboxesFile)
}

// VolumesStateFileIn returns the volumes state file path under the given state directory.
func VolumesStateFileIn(stateDir string) string {
	return filepath.Join(stateDir, volumesStateFile)
}
