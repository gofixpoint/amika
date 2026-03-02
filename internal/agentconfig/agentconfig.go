// Package agentconfig discovers coding agent configuration files on the host
// and produces mount specifications for sandboxes and ephemeral containers.
package agentconfig

import (
	"os"
	"path/filepath"

	"github.com/gofixpoint/amika/internal/sandbox"
)

// containerHome is the home directory inside preset container images.
const containerHome = "/home/amika"

// MountSpec describes a host path to mount into a container.
type MountSpec struct {
	HostPath      string // absolute path on host
	ContainerPath string // absolute path in container
	IsDir         bool   // true = directory, false = file
}

// ClaudeMounts returns mount specs for Claude Code configuration files that
// exist under homeDir. Returns nil if neither ~/.claude/ nor ~/.claude.json
// exists.
func ClaudeMounts(homeDir string) []MountSpec {
	var specs []MountSpec

	claudeDir := filepath.Join(homeDir, ".claude")
	if info, err := os.Stat(claudeDir); err == nil && info.IsDir() {
		specs = append(specs, MountSpec{
			HostPath:      claudeDir,
			ContainerPath: containerHome + "/.claude",
			IsDir:         true,
		})
	}

	claudeJSON := filepath.Join(homeDir, ".claude.json")
	if info, err := os.Stat(claudeJSON); err == nil && !info.IsDir() {
		specs = append(specs, MountSpec{
			HostPath:      claudeJSON,
			ContainerPath: containerHome + "/.claude.json",
			IsDir:         false,
		})
	}

	return specs
}

// OpenCodeMounts returns mount specs for OpenCode configuration directories that
// exist under homeDir.
func OpenCodeMounts(homeDir string) []MountSpec {
	var specs []MountSpec

	paths := []struct {
		rel       string
		container string
	}{
		{".config/opencode", containerHome + "/.config/opencode"},
		{filepath.Join(".local", "share", "opencode"), containerHome + "/.local/share/opencode"},
		{filepath.Join(".local", "state", "opencode"), containerHome + "/.local/state/opencode"},
	}

	for _, p := range paths {
		full := filepath.Join(homeDir, p.rel)
		if info, err := os.Stat(full); err == nil && info.IsDir() {
			specs = append(specs, MountSpec{
				HostPath:      full,
				ContainerPath: p.container,
				IsDir:         true,
			})
		}
	}

	return specs
}

// CodexMounts returns mount specs for Codex configuration directories that
// exist under homeDir.
func CodexMounts(homeDir string) []MountSpec {
	var specs []MountSpec

	codexDir := filepath.Join(homeDir, ".codex")
	if info, err := os.Stat(codexDir); err == nil && info.IsDir() {
		specs = append(specs, MountSpec{
			HostPath:      codexDir,
			ContainerPath: containerHome + "/.codex",
			IsDir:         true,
		})
	}

	return specs
}

// AllMounts returns mount specs for all supported coding agent configurations
// that exist under homeDir.
func AllMounts(homeDir string) []MountSpec {
	var specs []MountSpec
	specs = append(specs, ClaudeMounts(homeDir)...)
	specs = append(specs, OpenCodeMounts(homeDir)...)
	specs = append(specs, CodexMounts(homeDir)...)
	return specs
}

// RWCopyMounts converts MountSpecs into sandbox MountBindings with rwcopy mode.
func RWCopyMounts(specs []MountSpec) []sandbox.MountBinding {
	mounts := make([]sandbox.MountBinding, 0, len(specs))
	for _, s := range specs {
		mounts = append(mounts, sandbox.MountBinding{
			Type:   "bind",
			Source: s.HostPath,
			Target: s.ContainerPath,
			Mode:   "rwcopy",
		})
	}
	return mounts
}
