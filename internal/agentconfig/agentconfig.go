// Package agentconfig discovers coding agent configuration files on the host
// and produces mount specifications for sandboxes and ephemeral containers.
package agentconfig

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/sandbox"
)

// containerHome is the home directory inside preset container images.
const containerHome = "/home/amika"

// claudeConfigDir is the relative path of the Claude configuration directory.
const claudeConfigDir = ".claude"

// MountSpec describes a host path to mount into a container.
type MountSpec struct {
	HostPath      string // absolute path on host
	ContainerPath string // absolute path in container
	IsDir         bool   // true = directory, false = file
}

// ClaudeMounts returns mount specs for Claude Code credential files that
// exist under homeDir.
func ClaudeMounts(homeDir string) []MountSpec {
	return fileMounts(homeDir, auth.ClaudeCredentialPaths())
}

// OpenCodeMounts returns mount specs for OpenCode credential and config files
// that exist under homeDir.
func OpenCodeMounts(homeDir string) []MountSpec {
	paths := append(auth.OpenCodeCredentialPaths(),
		filepath.Join(".local", "state", "opencode", "model.json"),
	)
	return fileMounts(homeDir, paths)
}

// CodexMounts returns mount specs for Codex credential files that exist under
// homeDir.
func CodexMounts(homeDir string) []MountSpec {
	return fileMounts(homeDir, auth.CodexCredentialPaths())
}

// ClaudeConfigDirMount returns a mount spec for the ~/.claude/ directory if it
// exists under homeDir. Returns nil when the directory is absent.
func ClaudeConfigDirMount(homeDir string) *MountSpec {
	return dirMount(homeDir, claudeConfigDir)
}

// AllMounts returns mount specs for all supported coding agent configurations
// that exist under homeDir. When the ~/.claude/ directory exists it is mounted
// as a whole and individual file mounts inside it are omitted to avoid overlaps.
func AllMounts(homeDir string) []MountSpec {
	var specs []MountSpec
	claudeDir := ClaudeConfigDirMount(homeDir)
	if claudeDir != nil {
		specs = append(specs, *claudeDir)
		// Individual credential files inside .claude/ are already covered by
		// the directory mount — only keep top-level file mounts.
		specs = append(specs, filterOutSubpaths(ClaudeMounts(homeDir), claudeConfigDir+"/")...)
	} else {
		specs = append(specs, ClaudeMounts(homeDir)...)
	}
	specs = append(specs, OpenCodeMounts(homeDir)...)
	specs = append(specs, CodexMounts(homeDir)...)
	return specs
}

// AllMountsWithoutClaudeConfig returns mount specs for all supported coding
// agent configurations except the Claude config directory and Claude credential
// files. Use this when the --no-claude-config flag is set.
func AllMountsWithoutClaudeConfig(homeDir string) []MountSpec {
	var specs []MountSpec
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

// fileMounts stats each relative path under homeDir and returns a MountSpec
// for every path that exists as a regular file.
func fileMounts(homeDir string, relPaths []string) []MountSpec {
	var specs []MountSpec
	for _, rel := range relPaths {
		full := filepath.Join(homeDir, rel)
		info, err := os.Stat(full)
		if err != nil || info.IsDir() {
			continue
		}
		specs = append(specs, MountSpec{
			HostPath:      full,
			ContainerPath: containerHome + "/" + rel,
			IsDir:         false,
		})
	}
	return specs
}

// dirMount returns a MountSpec for relDir if it exists as a directory under
// homeDir. Returns nil when the path is absent or is a regular file.
func dirMount(homeDir, relDir string) *MountSpec {
	full := filepath.Join(homeDir, relDir)
	info, err := os.Stat(full)
	if err != nil || !info.IsDir() {
		return nil
	}
	return &MountSpec{
		HostPath:      full,
		ContainerPath: containerHome + "/" + relDir,
		IsDir:         true,
	}
}

// filterOutSubpaths returns specs whose container paths do not fall inside
// containerHome + "/" + prefix. This prevents double-mounting files that are
// already covered by a parent directory mount.
func filterOutSubpaths(specs []MountSpec, prefix string) []MountSpec {
	full := containerHome + "/" + prefix
	var out []MountSpec
	for _, s := range specs {
		if !strings.HasPrefix(s.ContainerPath, full) {
			out = append(out, s)
		}
	}
	return out
}
