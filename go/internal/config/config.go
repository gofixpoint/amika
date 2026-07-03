// Package config provides configuration and path resolution for amika.
package config

import (
	"net/url"
	"os"

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

	// DefaultAPIURL is the default remote API base URL.
	DefaultAPIURL = "https://app.amika.dev"
	// DefaultWorkOSClientID is the default WorkOS client ID for device auth.
	// It matches the production API at DefaultAPIURL.
	DefaultWorkOSClientID = "client_01KHA495MJS1KT6QBRTYJ239DY"

	// StagingHost is the host of the staging API. Requests against it must be
	// authenticated with the staging WorkOS environment, not production.
	StagingHost = "app.staging-amika.dev"
	// StagingWorkOSClientID is the WorkOS client ID for the staging
	// environment. The staging API verifies bearer tokens against this
	// client's issuer, so a token minted by DefaultWorkOSClientID
	// (production) is rejected with "Invalid bearer token".
	StagingWorkOSClientID = "client_01KHA4957S0742NKPKGAHV0JZE"
)

// APIURL returns the API base URL, checking AMIKA_API_URL first.
func APIURL() string {
	if u := os.Getenv(EnvAPIURL); u != "" {
		return u
	}
	return DefaultAPIURL
}

// WorkOSClientID returns the WorkOS client ID used for device auth and token
// verification. An explicit AMIKA_WORKOS_CLIENT_ID always wins. Otherwise the
// client ID is derived from the API URL so that pointing AMIKA_API_URL at a
// known environment (e.g. staging) authenticates against the matching WorkOS
// environment automatically. Without this, logging in against staging mints a
// production token that staging rejects with a 401 "Invalid bearer token".
func WorkOSClientID() string {
	if id := os.Getenv(EnvWorkOSClientID); id != "" {
		return id
	}
	return workOSClientIDForURL(APIURL())
}

// workOSClientIDForURL maps a known API URL to its WorkOS client ID, falling
// back to the production default for unrecognized hosts.
func workOSClientIDForURL(apiURL string) string {
	if u, err := url.Parse(apiURL); err == nil && u.Host == StagingHost {
		return StagingWorkOSClientID
	}
	return DefaultWorkOSClientID
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
