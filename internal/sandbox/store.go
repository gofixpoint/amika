package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// MountBinding represents a host directory mounted into a sandbox.
type MountBinding struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Mode   string `json:"mode"` // "ro" or "rw"
}

// Info represents a tracked sandbox.
type Info struct {
	Name        string         `json:"name"`
	Provider    string         `json:"provider"`
	ContainerID string         `json:"containerId"`
	Image       string         `json:"image"`
	CreatedAt   string         `json:"createdAt"`
	Preset      string         `json:"preset,omitempty"`
	Mounts      []MountBinding `json:"mounts,omitempty"`
	Env         []string       `json:"env,omitempty"`
}

// Store manages sandbox state persistence.
type Store interface {
	Save(info Info) error
	Get(name string) (Info, error)
	Remove(name string) error
	List() ([]Info, error)
}

type fileStore struct {
	dir string // the amika state directory path
}

// NewStore creates a Store backed by a JSONL file in the given directory.
func NewStore(dir string) Store {
	return &fileStore{dir: dir}
}

func (s *fileStore) filePath() string {
	return filepath.Join(s.dir, "sandboxes.jsonl")
}

func (s *fileStore) readAll() ([]Info, error) {
	f, err := os.Open(s.filePath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to open sandboxes file: %w", err)
	}
	defer f.Close()

	var sandboxes []Info
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var info Info
		if err := json.Unmarshal([]byte(line), &info); err != nil {
			continue // skip malformed lines
		}
		sandboxes = append(sandboxes, info)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read sandboxes file: %w", err)
	}
	return sandboxes, nil
}

func (s *fileStore) writeAll(sandboxes []Info) error {
	if err := os.MkdirAll(s.dir, 0755); err != nil {
		return fmt.Errorf("failed to create storage directory: %w", err)
	}

	f, err := os.Create(s.filePath())
	if err != nil {
		return fmt.Errorf("failed to create sandboxes file: %w", err)
	}
	defer f.Close()

	for _, info := range sandboxes {
		data, err := json.Marshal(info)
		if err != nil {
			return fmt.Errorf("failed to marshal sandbox info: %w", err)
		}
		if _, err := f.Write(data); err != nil {
			return fmt.Errorf("failed to write sandbox info: %w", err)
		}
		if _, err := f.WriteString("\n"); err != nil {
			return fmt.Errorf("failed to write newline: %w", err)
		}
	}
	return nil
}

func (s *fileStore) Save(info Info) error {
	sandboxes, err := s.readAll()
	if err != nil {
		return err
	}

	// Replace existing sandbox with same name, or append
	found := false
	for i, sb := range sandboxes {
		if sb.Name == info.Name {
			sandboxes[i] = info
			found = true
			break
		}
	}
	if !found {
		sandboxes = append(sandboxes, info)
	}

	return s.writeAll(sandboxes)
}

func (s *fileStore) Get(name string) (Info, error) {
	sandboxes, err := s.readAll()
	if err != nil {
		return Info{}, err
	}

	for _, sb := range sandboxes {
		if sb.Name == name {
			return sb, nil
		}
	}
	return Info{}, fmt.Errorf("no sandbox found with name: %s", name)
}

func (s *fileStore) Remove(name string) error {
	sandboxes, err := s.readAll()
	if err != nil {
		return err
	}

	var filtered []Info
	for _, sb := range sandboxes {
		if sb.Name != name {
			filtered = append(filtered, sb)
		}
	}

	if len(filtered) == len(sandboxes) {
		return nil
	}

	return s.writeAll(filtered)
}

func (s *fileStore) List() ([]Info, error) {
	return s.readAll()
}
