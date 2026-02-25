package state

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// MountInfo represents information about an active mount.
type MountInfo struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	Mode    string `json:"mode"`
	TempDir string `json:"tempDir,omitempty"` // Only used for overlay mode
}

// State provides an interface for managing mount state.
type State interface {
	// StateDir returns the path to the state directory.
	StateDir() string
	// SaveMount saves mount information to the state file.
	SaveMount(info MountInfo) error
	// GetMount retrieves mount information for a given target path.
	GetMount(target string) (MountInfo, error)
	// RemoveMount removes mount information for a given target path.
	RemoveMount(target string) error
	// ListMounts returns all active mounts.
	ListMounts() ([]MountInfo, error)
	// MountExists checks if a mount exists for the given target.
	MountExists(target string) bool
}

// fileState implements State using a JSONL file.
type fileState struct {
	stateDir string // amika state directory path
}

// NewState creates a new State instance.
// stateDir is the full path to the amika state directory.
func NewState(stateDir string) State {
	return &fileState{
		stateDir: stateDir,
	}
}

// StateDir returns the path to the state directory.
func (s *fileState) StateDir() string {
	return s.stateDir
}

// mountsFilePath returns the path to the mounts.jsonl file.
func (s *fileState) mountsFilePath() string {
	return filepath.Join(s.StateDir(), "mounts.jsonl")
}

// readAllMounts reads all mounts from the JSONL file.
func (s *fileState) readAllMounts() ([]MountInfo, error) {
	filePath := s.mountsFilePath()

	file, err := os.Open(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []MountInfo{}, nil
		}
		return nil, fmt.Errorf("failed to open mounts file: %w", err)
	}
	defer file.Close()

	var mounts []MountInfo
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var info MountInfo
		if err := json.Unmarshal([]byte(line), &info); err != nil {
			continue // Skip malformed lines
		}
		mounts = append(mounts, info)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read mounts file: %w", err)
	}

	return mounts, nil
}

// writeAllMounts writes all mounts to the JSONL file.
func (s *fileState) writeAllMounts(mounts []MountInfo) error {
	dir := s.StateDir()

	// Ensure state directory exists
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create state directory: %w", err)
	}

	filePath := s.mountsFilePath()
	file, err := os.Create(filePath)
	if err != nil {
		return fmt.Errorf("failed to create mounts file: %w", err)
	}
	defer file.Close()

	for _, info := range mounts {
		data, err := json.Marshal(info)
		if err != nil {
			return fmt.Errorf("failed to marshal mount info: %w", err)
		}
		if _, err := file.Write(data); err != nil {
			return fmt.Errorf("failed to write mount info: %w", err)
		}
		if _, err := file.WriteString("\n"); err != nil {
			return fmt.Errorf("failed to write newline: %w", err)
		}
	}

	return nil
}

// SaveMount saves mount information to the state file.
func (s *fileState) SaveMount(info MountInfo) error {
	mounts, err := s.readAllMounts()
	if err != nil {
		return err
	}

	// Replace existing mount with same target, or append
	found := false
	for i, m := range mounts {
		if m.Target == info.Target {
			mounts[i] = info
			found = true
			break
		}
	}
	if !found {
		mounts = append(mounts, info)
	}

	return s.writeAllMounts(mounts)
}

// GetMount retrieves mount information for a given target path.
func (s *fileState) GetMount(target string) (MountInfo, error) {
	mounts, err := s.readAllMounts()
	if err != nil {
		return MountInfo{}, err
	}

	for _, m := range mounts {
		if m.Target == target {
			return m, nil
		}
	}

	return MountInfo{}, fmt.Errorf("no mount found for target: %s", target)
}

// RemoveMount removes mount information for a given target path.
func (s *fileState) RemoveMount(target string) error {
	mounts, err := s.readAllMounts()
	if err != nil {
		return err
	}

	// Filter out the mount with matching target
	var filtered []MountInfo
	for _, m := range mounts {
		if m.Target != target {
			filtered = append(filtered, m)
		}
	}

	// If nothing changed, no need to write
	if len(filtered) == len(mounts) {
		return nil
	}

	return s.writeAllMounts(filtered)
}

// ListMounts returns all active mounts.
func (s *fileState) ListMounts() ([]MountInfo, error) {
	return s.readAllMounts()
}

// MountExists checks if a mount exists for the given target.
func (s *fileState) MountExists(target string) bool {
	_, err := s.GetMount(target)
	return err == nil
}
