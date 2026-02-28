package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

// VolumeInfo represents a tracked docker volume.
type VolumeInfo struct {
	Name       string   `json:"name"`
	CreatedAt  string   `json:"createdAt"`
	CreatedBy  string   `json:"createdBy,omitempty"`
	SourcePath string   `json:"sourcePath,omitempty"`
	SandboxRefs []string `json:"sandboxRefs,omitempty"`
}

// VolumeStore manages volume state persistence.
type VolumeStore interface {
	Save(info VolumeInfo) error
	Get(name string) (VolumeInfo, error)
	Remove(name string) error
	List() ([]VolumeInfo, error)
	AddSandboxRef(name, sandbox string) error
	RemoveSandboxRef(name, sandbox string) error
	VolumesForSandbox(sandbox string) ([]VolumeInfo, error)
	IsInUse(name string) (bool, error)
}

type fileVolumeStore struct {
	filePath string
}

// NewVolumeStore creates a VolumeStore backed by the provided volumes JSONL file path.
func NewVolumeStore(filePath string) VolumeStore {
	return &fileVolumeStore{filePath: filePath}
}

func (s *fileVolumeStore) readAll() ([]VolumeInfo, error) {
	f, err := os.Open(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to open volumes file: %w", err)
	}
	defer f.Close()

	var volumes []VolumeInfo
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var info VolumeInfo
		if err := json.Unmarshal([]byte(line), &info); err != nil {
			continue
		}
		volumes = append(volumes, info)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read volumes file: %w", err)
	}
	return volumes, nil
}

func (s *fileVolumeStore) writeAll(volumes []VolumeInfo) error {
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0755); err != nil {
		return fmt.Errorf("failed to create storage directory: %w", err)
	}

	f, err := os.Create(s.filePath)
	if err != nil {
		return fmt.Errorf("failed to create volumes file: %w", err)
	}
	defer f.Close()

	for _, info := range volumes {
		data, err := json.Marshal(info)
		if err != nil {
			return fmt.Errorf("failed to marshal volume info: %w", err)
		}
		if _, err := f.Write(data); err != nil {
			return fmt.Errorf("failed to write volume info: %w", err)
		}
		if _, err := f.WriteString("\n"); err != nil {
			return fmt.Errorf("failed to write newline: %w", err)
		}
	}

	return nil
}

func (s *fileVolumeStore) Save(info VolumeInfo) error {
	volumes, err := s.readAll()
	if err != nil {
		return err
	}

	found := false
	for i := range volumes {
		if volumes[i].Name == info.Name {
			volumes[i] = info
			found = true
			break
		}
	}
	if !found {
		volumes = append(volumes, info)
	}

	return s.writeAll(volumes)
}

func (s *fileVolumeStore) Get(name string) (VolumeInfo, error) {
	volumes, err := s.readAll()
	if err != nil {
		return VolumeInfo{}, err
	}

	for _, v := range volumes {
		if v.Name == name {
			return v, nil
		}
	}
	return VolumeInfo{}, fmt.Errorf("no volume found with name: %s", name)
}

func (s *fileVolumeStore) Remove(name string) error {
	volumes, err := s.readAll()
	if err != nil {
		return err
	}

	var filtered []VolumeInfo
	for _, v := range volumes {
		if v.Name != name {
			filtered = append(filtered, v)
		}
	}

	if len(filtered) == len(volumes) {
		return nil
	}

	return s.writeAll(filtered)
}

func (s *fileVolumeStore) List() ([]VolumeInfo, error) {
	return s.readAll()
}

func (s *fileVolumeStore) AddSandboxRef(name, sandbox string) error {
	info, err := s.Get(name)
	if err != nil {
		return err
	}

	if !slices.Contains(info.SandboxRefs, sandbox) {
		info.SandboxRefs = append(info.SandboxRefs, sandbox)
	}
	return s.Save(info)
}

func (s *fileVolumeStore) RemoveSandboxRef(name, sandbox string) error {
	info, err := s.Get(name)
	if err != nil {
		return err
	}

	refs := info.SandboxRefs[:0]
	for _, ref := range info.SandboxRefs {
		if ref != sandbox {
			refs = append(refs, ref)
		}
	}
	info.SandboxRefs = refs
	return s.Save(info)
}

func (s *fileVolumeStore) VolumesForSandbox(sandbox string) ([]VolumeInfo, error) {
	volumes, err := s.readAll()
	if err != nil {
		return nil, err
	}

	var result []VolumeInfo
	for _, v := range volumes {
		if slices.Contains(v.SandboxRefs, sandbox) {
			result = append(result, v)
		}
	}
	return result, nil
}

func (s *fileVolumeStore) IsInUse(name string) (bool, error) {
	info, err := s.Get(name)
	if err != nil {
		return false, err
	}
	return len(info.SandboxRefs) > 0, nil
}
