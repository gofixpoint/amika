package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const sandboxWorkdir = "/home/wisp/workspace"

type SandboxPaths interface {
	GetRoot() string
	GetWorkdir() string
	GetOutdir() string
	Cleanup() error
}

type tmpDirSandboxPaths struct {
	Root    string // Path to the sandbox root directory
	Workdir string // Path to the working directory within the sandbox
	Outdir  string // Subdirectory for output within the sandbox
}

func (s *tmpDirSandboxPaths) GetRoot() string {
	return s.Root
}

func (s *tmpDirSandboxPaths) GetWorkdir() string {
	return s.Workdir
}

func (s *tmpDirSandboxPaths) GetOutdir() string {
	return s.Outdir
}

func (s *tmpDirSandboxPaths) Cleanup() error {
	return os.RemoveAll(s.Root)
}

func NewTmpDirSandboxPaths(workdir, outdir string) (SandboxPaths, error) {
	root, err := os.MkdirTemp("", "wisp-sandbox-*")
	if err != nil {
		return nil, err
	}
	actualWorkdir := workdir
	if actualWorkdir == "" {
		actualWorkdir = sandboxWorkdir
	}
	resolved := resolveSandboxOutdir(root, outdir, actualWorkdir)
	if err := os.MkdirAll(resolved.GetWorkdir(), 0755); err != nil {
		os.RemoveAll(root) // clean up on failure
		return nil, fmt.Errorf("failed to create sandbox workdir: %w", err)
	}
	return resolved, nil
}

// resolveSandboxOutdir resolves the outdir flag relative to the sandbox.
//   - Empty → returns workdir (default: script CWD)
//   - Absolute → relative to sandbox root (e.g. /output → sandboxRoot/output)
//   - Relative → relative to workdir (e.g. out → workdir/out)
//   - Any absolute outdir or workdir is forcibly nested under sandboxRoot for security
func resolveSandboxOutdir(sandboxRoot, outdir, workdir string) SandboxPaths {
	// Ensure workdir is always nested under sandboxRoot
	cleanWorkdir := workdir
	if filepath.IsAbs(workdir) {
		cleanWorkdir = filepath.Join(sandboxRoot, strings.TrimPrefix(workdir, string(filepath.Separator)))
	} else {
		cleanWorkdir = filepath.Join(sandboxRoot, workdir)
	}

	var resolvedOutdir string
	if outdir == "" {
		resolvedOutdir = cleanWorkdir
	} else if filepath.IsAbs(outdir) {
		resolvedOutdir = filepath.Join(sandboxRoot, strings.TrimPrefix(outdir, string(filepath.Separator)))
	} else {
		resolvedOutdir = filepath.Join(cleanWorkdir, outdir)
	}

	return &tmpDirSandboxPaths{
		Root:    sandboxRoot,
		Workdir: cleanWorkdir,
		Outdir:  resolvedOutdir,
	}
}
