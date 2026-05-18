package amika

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/sandbox"
)

const defaultMaxCatBytes int64 = 10 * 1024 * 1024 // 10MB

// requireRunningSandbox looks up a sandbox by name and verifies its container
// is in the "running" state. Returns the sandbox record or a typed error.
func (s *serviceImpl) requireRunningSandbox(name string) (sandbox.Info, error) {
	info, err := s.sandboxes.Get(name)
	if err != nil {
		return sandbox.Info{}, fmt.Errorf("%w: sandbox %q", ErrNotFound, name)
	}
	state, err := sandbox.GetDockerContainerState(name)
	if err != nil {
		return sandbox.Info{}, fmt.Errorf("%w: %v", ErrDependency, err)
	}
	if state != "running" {
		return sandbox.Info{}, fmt.Errorf("%w: sandbox %q is not running; start it first or use 'sandbox cp'", ErrInvalidArgument, name)
	}
	return info, nil
}

func (s *serviceImpl) CopyFromSandbox(_ context.Context, req CopyFromSandboxRequest) (CopyFromSandboxResult, error) {
	if req.Name == "" {
		return CopyFromSandboxResult{}, fmt.Errorf("%w: sandbox name is required", ErrInvalidArgument)
	}
	if req.ContainerPath == "" {
		return CopyFromSandboxResult{}, fmt.Errorf("%w: container path is required", ErrInvalidArgument)
	}
	if req.HostPath == "" {
		return CopyFromSandboxResult{}, fmt.Errorf("%w: host path is required", ErrInvalidArgument)
	}
	if _, err := s.sandboxes.Get(req.Name); err != nil {
		return CopyFromSandboxResult{}, fmt.Errorf("%w: sandbox %q", ErrNotFound, req.Name)
	}
	if err := sandbox.CopyFromContainer(req.Name, req.ContainerPath, req.HostPath); err != nil {
		return CopyFromSandboxResult{}, mapDockerError(err, req.Name, req.ContainerPath)
	}
	return CopyFromSandboxResult{}, nil
}

func (s *serviceImpl) SandboxLs(_ context.Context, req SandboxLsRequest) (SandboxLsResult, error) {
	if req.Name == "" {
		return SandboxLsResult{}, fmt.Errorf("%w: sandbox name is required", ErrInvalidArgument)
	}
	if req.Path == "" {
		return SandboxLsResult{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	if _, err := s.requireRunningSandbox(req.Name); err != nil {
		return SandboxLsResult{}, err
	}
	// Use stat -c to get structured output for each entry
	out, err := sandbox.ExecInContainer(req.Name, []string{
		"sh", "-c", fmt.Sprintf("stat -c '%%n|%%s|%%a|%%Y|%%F' %s/* %s/.* 2>/dev/null || true", req.Path, req.Path),
	})
	if err != nil {
		return SandboxLsResult{}, mapDockerError(err, req.Name, req.Path)
	}
	entries := ParseStatOutput(out)
	// Filter out . and .. entries
	filtered := make([]SandboxFileInfo, 0, len(entries))
	for _, e := range entries {
		base := e.Name
		if idx := strings.LastIndex(base, "/"); idx >= 0 {
			base = base[idx+1:]
		}
		if base == "." || base == ".." {
			continue
		}
		e.Name = base
		filtered = append(filtered, e)
	}
	return SandboxLsResult{Entries: filtered}, nil
}

func (s *serviceImpl) SandboxCat(_ context.Context, req SandboxCatRequest) (SandboxCatResult, error) {
	if req.Name == "" {
		return SandboxCatResult{}, fmt.Errorf("%w: sandbox name is required", ErrInvalidArgument)
	}
	if req.Path == "" {
		return SandboxCatResult{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	if _, err := s.requireRunningSandbox(req.Name); err != nil {
		return SandboxCatResult{}, err
	}
	maxBytes := req.MaxBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxCatBytes
	}
	// Use head -c to cap at maxBytes+1 to detect truncation
	limit := maxBytes + 1
	out, err := sandbox.ExecInContainer(req.Name, []string{
		"head", "-c", strconv.FormatInt(limit, 10), req.Path,
	})
	if err != nil {
		return SandboxCatResult{}, mapDockerError(err, req.Name, req.Path)
	}
	if int64(len(out)) > maxBytes {
		return SandboxCatResult{}, fmt.Errorf("%w: file exceeds %dMB limit; use 'sandbox cp' instead", ErrInvalidArgument, maxBytes/(1024*1024))
	}
	return SandboxCatResult{Content: out, Truncated: false}, nil
}

func (s *serviceImpl) SandboxRm(_ context.Context, req SandboxRmRequest) (SandboxRmResult, error) {
	if req.Name == "" {
		return SandboxRmResult{}, fmt.Errorf("%w: sandbox name is required", ErrInvalidArgument)
	}
	if req.Path == "" {
		return SandboxRmResult{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	if _, err := s.requireRunningSandbox(req.Name); err != nil {
		return SandboxRmResult{}, err
	}
	rmArgs := []string{"rm"}
	if req.Recursive {
		rmArgs = append(rmArgs, "-r")
	}
	if req.Force {
		rmArgs = append(rmArgs, "-f")
	}
	rmArgs = append(rmArgs, req.Path)
	if _, err := sandbox.ExecInContainer(req.Name, rmArgs); err != nil {
		return SandboxRmResult{}, mapDockerError(err, req.Name, req.Path)
	}
	return SandboxRmResult{}, nil
}

func (s *serviceImpl) SandboxStat(_ context.Context, req SandboxStatRequest) (SandboxStatResult, error) {
	if req.Name == "" {
		return SandboxStatResult{}, fmt.Errorf("%w: sandbox name is required", ErrInvalidArgument)
	}
	if req.Path == "" {
		return SandboxStatResult{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	if _, err := s.requireRunningSandbox(req.Name); err != nil {
		return SandboxStatResult{}, err
	}
	out, err := sandbox.ExecInContainer(req.Name, []string{
		"stat", "-c", "%n|%s|%a|%Y|%F", req.Path,
	})
	if err != nil {
		return SandboxStatResult{}, mapDockerError(err, req.Name, req.Path)
	}
	entries := ParseStatOutput(out)
	if len(entries) == 0 {
		return SandboxStatResult{}, fmt.Errorf("%w: path %q not found in sandbox %q", ErrNotFound, req.Path, req.Name)
	}
	return SandboxStatResult{Info: entries[0]}, nil
}

// ParseStatOutput parses lines of `stat -c '%n|%s|%a|%Y|%F'` output into SandboxFileInfo entries.
func ParseStatOutput(output string) []SandboxFileInfo {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	entries := make([]SandboxFileInfo, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 5)
		if len(parts) < 5 {
			continue
		}
		size, _ := strconv.ParseInt(parts[1], 10, 64)
		mtime, _ := strconv.ParseInt(parts[3], 10, 64)
		modTime := time.Unix(mtime, 0).UTC().Format(time.RFC3339)
		fileType := strings.TrimSpace(parts[4])
		isDir := fileType == "directory"
		entries = append(entries, SandboxFileInfo{
			Name:    parts[0],
			Size:    size,
			Mode:    parts[2],
			ModTime: modTime,
			IsDir:   isDir,
		})
	}
	return entries
}

// mapDockerError maps Docker error messages to typed sentinel errors.
func mapDockerError(err error, sandboxName, path string) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "not found"):
		if strings.Contains(msg, "container") {
			return fmt.Errorf("%w: sandbox %q", ErrNotFound, sandboxName)
		}
		return fmt.Errorf("%w: path %q not found in sandbox %q", ErrNotFound, path, sandboxName)
	case strings.Contains(msg, "not running"):
		return fmt.Errorf("%w: sandbox %q is not running", ErrInvalidArgument, sandboxName)
	case strings.Contains(msg, "permission denied"):
		return fmt.Errorf("%w: permission denied: %q in sandbox %q", ErrInternal, path, sandboxName)
	default:
		return fmt.Errorf("%w: %v", ErrDependency, err)
	}
}