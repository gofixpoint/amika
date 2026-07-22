// Package basedir resolves XDG base directories and Amika-managed file paths.
package basedir

import (
	"fmt"
	"os"
	"path/filepath"
)

const (
	appName             = "amika"
	envCacheFile        = "env-cache.json"
	keychainFile        = "keychain.json"
	oauthFile           = "oauth.json"
	mountsStateFile     = "mounts.jsonl"
	sandboxesFile       = "sandboxes.jsonl"
	volumesStateFile    = "volumes.jsonl"
	fileMountsStateFile = "rwcopy-mounts.jsonl"
	fileMountsDir       = "rwcopy-mounts.d"
	workosSessionFile   = "workos-session.json"
	apiKeyFile          = "api-key.json"
	sshHostsStateFile   = "ssh-hosts.json"
	sshDirName          = ".ssh"
	sshConfigFile       = "config"
	sshAmikaConfigFile  = "amika.conf"
	envXDGConfigHome    = "XDG_CONFIG_HOME"
	envXDGDataHome      = "XDG_DATA_HOME"
	envXDGCacheHome     = "XDG_CACHE_HOME"
	envXDGStateHome     = "XDG_STATE_HOME"
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
	FileMountsStateFile() (string, error)
	FileMountsDir() (string, error)
	WorkOSAuthSessionFile() (string, error)
	APIKeyFile() (string, error)

	SSHHostsStateFile() (string, error)
	SSHDir() (string, error)
	SSHConfigFile() (string, error)
	SSHAmikaConfigFile() (string, error)
}

type xdgPaths struct {
	homeOverride     string
	stateDirOverride string
}

// New returns a Paths resolver. If homeOverride is non-empty, XDG fallback
// directories are resolved relative to that home directory.
func New(homeOverride string) Paths {
	return &xdgPaths{homeOverride: homeOverride}
}

// NewWithStateDir returns a Paths resolver like New but with the Amika state
// directory forced to stateDirOverride when it is non-empty. Callers use this
// to honor AMIKA_STATE_DIRECTORY (read by the config package) without teaching
// this package about that env var; an empty stateDirOverride behaves like New.
func NewWithStateDir(homeOverride, stateDirOverride string) Paths {
	return &xdgPaths{homeOverride: homeOverride, stateDirOverride: stateDirOverride}
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
	if p.stateDirOverride != "" {
		return p.stateDirOverride, nil
	}
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

func (p *xdgPaths) FileMountsStateFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return FileMountsStateFileIn(dir), nil
}

func (p *xdgPaths) FileMountsDir() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return FileMountsDirIn(dir), nil
}

func (p *xdgPaths) WorkOSAuthSessionFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return WorkOSAuthSessionFileIn(dir), nil
}

func (p *xdgPaths) APIKeyFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return APIKeyFileIn(dir), nil
}

// SSHHostsStateFile returns the JSON file that records the managed SSH host
// entries. It is the source of truth from which the SSH config is regenerated.
func (p *xdgPaths) SSHHostsStateFile() (string, error) {
	dir, err := p.AmikaStateDir()
	if err != nil {
		return "", err
	}
	return SSHHostsStateFileIn(dir), nil
}

// SSHDir returns the user's ~/.ssh directory.
func (p *xdgPaths) SSHDir() (string, error) {
	home, err := p.HomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, sshDirName), nil
}

// SSHConfigFile returns the user's primary ~/.ssh/config file.
func (p *xdgPaths) SSHConfigFile() (string, error) {
	dir, err := p.SSHDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, sshConfigFile), nil
}

// SSHAmikaConfigFile returns the Amika-managed ~/.ssh/amika.conf file, which is
// pulled into the primary config via an Include directive.
func (p *xdgPaths) SSHAmikaConfigFile() (string, error) {
	dir, err := p.SSHDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, sshAmikaConfigFile), nil
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

// FileMountsStateFileIn returns the file mounts state file path under the given state directory.
func FileMountsStateFileIn(stateDir string) string {
	return filepath.Join(stateDir, fileMountsStateFile)
}

// FileMountsDirIn returns the file mounts directory path under the given state directory.
func FileMountsDirIn(stateDir string) string {
	return filepath.Join(stateDir, fileMountsDir)
}

// WorkOSAuthSessionFileIn returns the WorkOS auth session file path under the given state directory.
func WorkOSAuthSessionFileIn(stateDir string) string {
	return filepath.Join(stateDir, workosSessionFile)
}

// APIKeyFileIn returns the stored API key file path under the given state directory.
func APIKeyFileIn(stateDir string) string {
	return filepath.Join(stateDir, apiKeyFile)
}

// SSHHostsStateFileIn returns the managed SSH hosts state file path under the given state directory.
func SSHHostsStateFileIn(stateDir string) string {
	return filepath.Join(stateDir, sshHostsStateFile)
}

// SSHAmikaConfigName returns the bare filename of the Amika-managed SSH config,
// as it should appear in an `Include` directive within ~/.ssh/config (Include
// paths are resolved relative to ~/.ssh).
func SSHAmikaConfigName() string {
	return sshAmikaConfigFile
}
