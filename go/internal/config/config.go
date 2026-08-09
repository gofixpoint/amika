// Package config provides configuration and path resolution for amika.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/amika/go/internal/basedir"
)

const (
	// EnvStateDirectory is the environment variable that overrides the default state directory.
	EnvStateDirectory = "AMIKA_STATE_DIRECTORY"
	// EnvAPIURL is the environment variable that overrides the default API base URL.
	EnvAPIURL = "AMIKA_API_URL"
	// EnvWorkOSClientID is the environment variable that overrides the default WorkOS client ID.
	EnvWorkOSClientID = "AMIKA_WORKOS_CLIENT_ID"
	// EnvAPIKey is the environment variable that provides a WorkOS organization API key
	// for bearer-token authentication. When set, it takes precedence over stored credentials.
	EnvAPIKey = "AMIKA_API_KEY"
	// EnvBinaryPath is the environment variable that overrides the amika executable
	// path recorded in generated configuration that re-invokes amika later.
	EnvBinaryPath = "AMIKA_BINARY_PATH"

	// DefaultAPIURL is the default remote API base URL.
	DefaultAPIURL = "https://app.amika.dev"
	// DefaultWorkOSClientID is the default WorkOS client ID for device auth.
	DefaultWorkOSClientID = "client_01KHA495MJS1KT6QBRTYJ239DY"
)

// APIURL returns the API base URL, checking AMIKA_API_URL first.
func APIURL() string {
	if u := os.Getenv(EnvAPIURL); u != "" {
		return u
	}
	return DefaultAPIURL
}

// WorkOSClientID returns the WorkOS client ID, checking AMIKA_WORKOS_CLIENT_ID first.
func WorkOSClientID() string {
	if id := os.Getenv(EnvWorkOSClientID); id != "" {
		return id
	}
	return DefaultWorkOSClientID
}

// BinaryPath returns the absolute path of the amika executable to record in
// generated configuration that re-invokes amika later, such as the SSH
// ProxyCommand in ~/.ssh/amika.conf.
//
// It defaults to the running executable. AMIKA_BINARY_PATH overrides that,
// because os.Executable resolves to the real binary and can never see that it
// was invoked through a wrapper script. A wrapper that exports AMIKA_API_URL
// (and friends) must name itself here, or the generated config would point at
// the bare binary and lose the wrapper's environment.
//
// An override that is not a usable absolute path is an error rather than a
// silent fallback: the value ends up in a config file that has to work later,
// and a typo would otherwise surface as an opaque connection failure.
func BinaryPath() (string, error) {
	override := os.Getenv(EnvBinaryPath)
	if override == "" {
		path, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("resolve amika executable: %w", err)
		}
		return path, nil
	}
	if !filepath.IsAbs(override) {
		return "", fmt.Errorf("%s must be an absolute path, got %q", EnvBinaryPath, override)
	}
	path := filepath.Clean(override)
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("%s %q: %w", EnvBinaryPath, path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s %q is not a regular file", EnvBinaryPath, path)
	}
	return path, nil
}

// EnvironmentSlug returns a stable identifier for the control plane named by
// AMIKA_API_URL, safe to embed as one segment of an SSH host alias.
//
// Sandboxes only exist on the control plane that created them, so anything
// keyed by sandbox — host-key pins, session config blocks — has to be keyed by
// environment too, or a local and a staging sandbox sharing a name would
// collide. Deriving the slug from the URL rather than a user-supplied label
// means it cannot drift from the control plane it actually names.
func EnvironmentSlug() (string, error) {
	return environmentSlugFor(APIURL())
}

// environmentSlugFor reduces an API base URL to its host and port, lowercased
// with every character outside [a-z0-9-] folded to a single dash. Dots included:
// the slug is one alias segment, and a dot in it would break the parse.
func environmentSlugFor(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse %s %q: %w", EnvAPIURL, rawURL, err)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("%s %q has no host", EnvAPIURL, rawURL)
	}
	var b strings.Builder
	for _, r := range strings.ToLower(parsed.Host) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-':
			b.WriteRune(r)
		case b.Len() > 0 && b.String()[b.Len()-1] != '-':
			b.WriteByte('-')
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		return "", fmt.Errorf("%s %q has no usable host characters", EnvAPIURL, rawURL)
	}
	// 63 is the DNS label limit. Real control-plane hosts are far shorter, and
	// truncating instead would let two environments collapse onto one slug.
	if len(slug) > 63 {
		return "", fmt.Errorf("%s %q host is too long for an SSH alias segment", EnvAPIURL, rawURL)
	}
	return slug, nil
}

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

// FileMountsStateFile returns the resolved file mounts state file path.
func FileMountsStateFile() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.FileMountsStateFileIn(dir), nil
	}
	return basedir.New("").FileMountsStateFile()
}

// FileMountsDir returns the resolved file mounts directory path.
func FileMountsDir() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.FileMountsDirIn(dir), nil
	}
	return basedir.New("").FileMountsDir()
}

// WorkOSAuthSessionFile returns the resolved WorkOS auth session file path.
func WorkOSAuthSessionFile() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.WorkOSAuthSessionFileIn(dir), nil
	}
	return basedir.New("").WorkOSAuthSessionFile()
}

// APIKeyFile returns the resolved stored API key file path.
func APIKeyFile() (string, error) {
	if dir := os.Getenv(EnvStateDirectory); dir != "" {
		return basedir.APIKeyFileIn(dir), nil
	}
	return basedir.New("").APIKeyFile()
}
