package amikalyze

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const gitTimeout = 500 * time.Millisecond

// ErrNotRepository means a path is not inside a Git worktree. Amikalyze has
// no filesystem boundary in that case, so global agent hooks allow the edit.
var ErrNotRepository = errors.New("not inside a Git worktree")

// Overrides describes the process-scoped exceptions created by `amikalyze
// run`. Paths are canonical, repository-relative paths using forward slashes.
type Overrides struct {
	RepoRoot string   `json:"repo_root"`
	Labels   []string `json:"labels,omitempty"`
	Paths    []string `json:"paths,omitempty"`
}

// Match identifies one freeze rule that applies to a target path.
type Match struct {
	Label      string
	Pattern    string
	ConfigPath string
}

// Decision is the result of evaluating one target path.
type Decision struct {
	TargetPath string
	RepoPath   string
	Matches    []Match
}

// Frozen reports whether at least one non-overridden rule matched the target.
func (d Decision) Frozen() bool {
	return len(d.Matches) > 0
}

// RepositoryRoot returns the absolute Git worktree root containing dir.
func RepositoryRoot(dir string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", fmt.Errorf("resolving repository root from %s: git timed out", dir)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return "", ErrNotRepository
		}
		return "", fmt.Errorf("resolving repository root from %s: %w", dir, err)
	}
	root, err := filepath.Abs(strings.TrimSpace(string(out)))
	if err != nil {
		return "", fmt.Errorf("resolving absolute repository root: %w", err)
	}
	return filepath.Clean(root), nil
}

// Evaluate checks target against every .amikalyze.toml on its ancestor path,
// stopping at repoRoot. Patterns are relative to their config's directory.
func Evaluate(repoRoot, target string, overrides Overrides) (Decision, error) {
	repoRoot, err := filepath.Abs(repoRoot)
	if err != nil {
		return Decision{}, fmt.Errorf("resolving repository root: %w", err)
	}
	repoRoot, err = filepath.EvalSymlinks(repoRoot)
	if err != nil {
		return Decision{}, fmt.Errorf("resolving repository root: %w", err)
	}
	repoPath, inside := repoRelative(repoRoot, target)
	if !inside {
		return Decision{}, fmt.Errorf("target %s is outside repository %s", target, repoRoot)
	}
	target = filepath.Join(repoRoot, repoPath)
	decision := Decision{TargetPath: target, RepoPath: filepath.ToSlash(repoPath)}

	configs, err := discoverConfigs(repoRoot, filepath.Dir(target))
	if err != nil {
		return decision, err
	}
	labels := make(map[string]string)
	unfrozenLabels := sliceSet(overrides.Labels)
	unfrozenPaths := sliceSet(overrides.Paths)
	pathOverride := samePath(overrides.RepoRoot, repoRoot) && contains(unfrozenPaths, decision.RepoPath)

	for _, config := range configs {
		for _, freeze := range config.config.Freezes {
			if previous, duplicate := labels[freeze.Label]; duplicate {
				return decision, fmt.Errorf("freeze label %q is defined in both %s and %s", freeze.Label, previous, config.path)
			}
			labels[freeze.Label] = config.path
			if pathOverride || (samePath(overrides.RepoRoot, repoRoot) && contains(unfrozenLabels, freeze.Label)) {
				continue
			}
			relative, inside := relativeInside(config.dir, target)
			if !inside {
				continue
			}
			name := filepath.ToSlash(relative)
			for _, pattern := range freeze.Paths {
				if matchPattern(pattern, name) {
					decision.Matches = append(decision.Matches, Match{
						Label:      freeze.Label,
						Pattern:    pattern,
						ConfigPath: config.path,
					})
				}
			}
		}
		if !pathOverride && samePath(config.path, target) {
			decision.Matches = append(decision.Matches, Match{
				Label:      "amikalyze-policy",
				Pattern:    configName,
				ConfigPath: config.path,
			})
		}
	}

	sort.Slice(decision.Matches, func(i, j int) bool {
		left, right := decision.Matches[i], decision.Matches[j]
		if left.ConfigPath != right.ConfigPath {
			return left.ConfigPath < right.ConfigPath
		}
		if left.Label != right.Label {
			return left.Label < right.Label
		}
		return left.Pattern < right.Pattern
	})
	return decision, nil
}

func discoverConfigs(repoRoot, targetDir string) ([]loadedConfig, error) {
	relative, inside := relativeInside(repoRoot, targetDir)
	if !inside {
		return nil, fmt.Errorf("target directory %s is outside repository %s", targetDir, repoRoot)
	}
	directories := []string{repoRoot}
	if relative != "." {
		current := repoRoot
		for _, segment := range strings.Split(filepath.Clean(relative), string(filepath.Separator)) {
			current = filepath.Join(current, segment)
			directories = append(directories, current)
		}
	}

	configs := make([]loadedConfig, 0, len(directories))
	for _, directory := range directories {
		filename := filepath.Join(directory, configName)
		config, err := loadConfig(filename)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		configs = append(configs, config)
	}
	return configs, nil
}

func relativeInside(base, target string) (string, bool) {
	relative, err := filepath.Rel(base, target)
	if err != nil {
		return "", false
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return relative, true
}

// repoRelative returns target's path relative to repoRoot, which must have its
// symlinks resolved, as Git reports it. Git and the agent can spell the same
// directory differently (on macOS, /var and /tmp are symlinks into /private,
// and a cwd may be a symlink to a directory inside the repository), so this
// finds the outermost ancestor of target that resolves into the repository
// and keeps the components below it as written. Symlinks inside the
// repository are not followed: a target is matched by the path the agent
// names.
func repoRelative(repoRoot, target string) (string, bool) {
	target, err := filepath.Abs(target)
	if err != nil {
		return "", false
	}
	repoPath, found := "", false
	dir, rest := filepath.Dir(target), []string{filepath.Base(target)}
	for {
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			if prefix, inside := relativeInside(repoRoot, resolved); inside {
				repoPath, found = filepath.Join(append([]string{prefix}, rest...)...), true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return repoPath, found
		}
		rest = append([]string{filepath.Base(dir)}, rest...)
		dir = parent
	}
}

func samePath(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	// Compare resolved paths where they exist, so a repository root spelled
	// through a symlink matches the resolved root Evaluate works from.
	if resolved, err := filepath.EvalSymlinks(leftAbs); err == nil {
		leftAbs = resolved
	}
	if resolved, err := filepath.EvalSymlinks(rightAbs); err == nil {
		rightAbs = resolved
	}
	return filepath.Clean(leftAbs) == filepath.Clean(rightAbs)
}

func sliceSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		set[value] = struct{}{}
	}
	return set
}

func contains(set map[string]struct{}, value string) bool {
	_, ok := set[value]
	return ok
}
