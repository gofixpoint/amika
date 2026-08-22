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
	target, err = filepath.Abs(target)
	if err != nil {
		return Decision{}, fmt.Errorf("resolving target path: %w", err)
	}
	repoRoot = filepath.Clean(repoRoot)
	target = filepath.Clean(target)
	repoPath, inside := relativeInside(repoRoot, target)
	if !inside {
		return Decision{}, fmt.Errorf("target %s is outside repository %s", target, repoRoot)
	}
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

func samePath(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	return leftErr == nil && rightErr == nil && filepath.Clean(leftAbs) == filepath.Clean(rightAbs)
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
