package amikalyze

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

const overridesEnv = "AMIKALYZE_RUN_OVERRIDES"

// NewOverrides validates and canonicalizes process-scoped label and exact-path
// exceptions. unfreezePaths must be repository-relative paths, not globs.
func NewOverrides(repoRoot string, labels, unfreezePaths []string) (Overrides, error) {
	repoRoot, err := filepath.Abs(repoRoot)
	if err != nil {
		return Overrides{}, fmt.Errorf("resolving repository root: %w", err)
	}
	overrides := Overrides{RepoRoot: filepath.Clean(repoRoot)}
	labelSet := make(map[string]struct{}, len(labels))
	for _, label := range labels {
		if err := validateLabel(label); err != nil {
			return Overrides{}, fmt.Errorf("invalid --unfreeze value: %w", err)
		}
		labelSet[label] = struct{}{}
	}
	for label := range labelSet {
		overrides.Labels = append(overrides.Labels, label)
	}
	sort.Strings(overrides.Labels)

	pathSet := make(map[string]struct{}, len(unfreezePaths))
	for _, value := range unfreezePaths {
		canonical, err := canonicalUnfreezePath(value)
		if err != nil {
			return Overrides{}, fmt.Errorf("invalid --unfreeze-path value %q: %w", value, err)
		}
		pathSet[canonical] = struct{}{}
	}
	for value := range pathSet {
		overrides.Paths = append(overrides.Paths, value)
	}
	sort.Strings(overrides.Paths)
	return overrides, nil
}

// OverridesEnvironment returns an environment assignment carrying overrides
// from `amikalyze run` to its child agent and the hooks that child launches.
func OverridesEnvironment(overrides Overrides) (string, error) {
	encoded, err := json.Marshal(overrides)
	if err != nil {
		return "", fmt.Errorf("encoding run overrides: %w", err)
	}
	return overridesEnv + "=" + string(encoded), nil
}

// OverridesFromEnvironment reads process-scoped overrides created by
// `amikalyze run`. An unset variable means no overrides.
func OverridesFromEnvironment() (Overrides, error) {
	value := os.Getenv(overridesEnv)
	if value == "" {
		return Overrides{}, nil
	}
	var overrides Overrides
	if err := json.Unmarshal([]byte(value), &overrides); err != nil {
		return Overrides{}, fmt.Errorf("parsing %s: %w", overridesEnv, err)
	}
	if overrides.RepoRoot == "" {
		return Overrides{}, fmt.Errorf("parsing %s: missing repo_root", overridesEnv)
	}
	return NewOverrides(overrides.RepoRoot, overrides.Labels, overrides.Paths)
}

// ReplaceOverridesEnvironment returns environ with any prior internal
// override assignment removed and the supplied one appended.
func ReplaceOverridesEnvironment(environ []string, assignment string) []string {
	prefix := overridesEnv + "="
	result := make([]string, 0, len(environ)+1)
	for _, value := range environ {
		if !strings.HasPrefix(value, prefix) {
			result = append(result, value)
		}
	}
	return append(result, assignment)
}

func canonicalUnfreezePath(value string) (string, error) {
	if value == "" {
		return "", errors.New("must not be empty")
	}
	if strings.Contains(value, "\\") {
		return "", errors.New("must use forward slashes")
	}
	if strings.HasSuffix(value, "/") {
		return "", errors.New("must identify a file, not a directory")
	}
	if path.IsAbs(value) || filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return "", errors.New("must be relative to the repository root")
	}
	segments := strings.Split(value, "/")
	for _, segment := range segments {
		if segment == ".." {
			return "", errors.New("must not contain .. path segments")
		}
	}
	cleaned := path.Clean(value)
	if cleaned == "." || strings.ContainsAny(cleaned, "*?[") {
		return "", errors.New("must identify one exact file, not a directory or glob")
	}
	return cleaned, nil
}
