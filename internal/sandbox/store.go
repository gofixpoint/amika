package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// SandboxInfo represents a tracked sandbox.
type SandboxInfo struct {
	Name        string `json:"name"`
	Provider    string `json:"provider"`
	ContainerID string `json:"containerId"`
	Image       string `json:"image"`
	CreatedAt   string `json:"createdAt"`
}

// SandboxStore manages sandbox state persistence.
type SandboxStore interface {
	Save(info SandboxInfo) error
	Get(name string) (SandboxInfo, error)
	Remove(name string) error
	List() ([]SandboxInfo, error)
}

type fileSandboxStore struct {
	dir string // e.g. ".clawbox"
}

// NewSandboxStore creates a SandboxStore backed by a JSONL file in the given directory.
func NewSandboxStore(dir string) SandboxStore {
	return &fileSandboxStore{dir: dir}
}

func (s *fileSandboxStore) filePath() string {
	return filepath.Join(s.dir, "sandboxes.jsonl")
}

func (s *fileSandboxStore) readAll() ([]SandboxInfo, error) {
	f, err := os.Open(s.filePath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to open sandboxes file: %w", err)
	}
	defer f.Close()

	var sandboxes []SandboxInfo
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var info SandboxInfo
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

func (s *fileSandboxStore) writeAll(sandboxes []SandboxInfo) error {
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

func (s *fileSandboxStore) Save(info SandboxInfo) error {
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

func (s *fileSandboxStore) Get(name string) (SandboxInfo, error) {
	sandboxes, err := s.readAll()
	if err != nil {
		return SandboxInfo{}, err
	}

	for _, sb := range sandboxes {
		if sb.Name == name {
			return sb, nil
		}
	}
	return SandboxInfo{}, fmt.Errorf("no sandbox found with name: %s", name)
}

func (s *fileSandboxStore) Remove(name string) error {
	sandboxes, err := s.readAll()
	if err != nil {
		return err
	}

	var filtered []SandboxInfo
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

func (s *fileSandboxStore) List() ([]SandboxInfo, error) {
	return s.readAll()
}
