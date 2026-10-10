package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"slices"
)

// VolumeInfo represents a tracked docker volume.
type VolumeInfo struct {
	Name        string   `json:"name"`
	CreatedAt   string   `json:"createdAt"`
	CreatedBy   string   `json:"createdBy,omitempty"`
	SourcePath  string   `json:"sourcePath,omitempty"`
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
	lines, err := marshalJSONL(volumes, "volume info")
	if err != nil {
		return err
	}
	return writeJSONLAtomic(s.filePath, lines)
}

// update runs fn over the current entries while holding the store's advisory
// lock and atomically writes the result back, so concurrent processes cannot
// drop each other's changes through last-writer-wins. A false changed skips
// the write.
func (s *fileVolumeStore) update(fn func(volumes []VolumeInfo) ([]VolumeInfo, bool, error)) error {
	lock, err := lockStore(s.filePath)
	if err != nil {
		return err
	}
	defer lock.Close()

	volumes, err := s.readAll()
	if err != nil {
		return err
	}
	updated, changed, err := fn(volumes)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	return s.writeAll(updated)
}

func (s *fileVolumeStore) Save(info VolumeInfo) error {
	return s.update(func(volumes []VolumeInfo) ([]VolumeInfo, bool, error) {
		for i, v := range volumes {
			if v.Name == info.Name {
				volumes[i] = info
				return volumes, true, nil
			}
		}
		return append(volumes, info), true, nil
	})
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
	return s.update(func(volumes []VolumeInfo) ([]VolumeInfo, bool, error) {
		var filtered []VolumeInfo
		for _, v := range volumes {
			if v.Name != name {
				filtered = append(filtered, v)
			}
		}

		if len(filtered) == len(volumes) {
			return volumes, false, nil
		}
		return filtered, true, nil
	})
}

func (s *fileVolumeStore) List() ([]VolumeInfo, error) {
	return s.readAll()
}

func (s *fileVolumeStore) AddSandboxRef(name, sandbox string) error {
	return s.update(func(volumes []VolumeInfo) ([]VolumeInfo, bool, error) {
		for i, v := range volumes {
			if v.Name != name {
				continue
			}
			if !slices.Contains(v.SandboxRefs, sandbox) {
				v.SandboxRefs = append(v.SandboxRefs, sandbox)
				volumes[i] = v
			}
			return volumes, true, nil
		}
		return nil, false, fmt.Errorf("no volume found with name: %s", name)
	})
}

func (s *fileVolumeStore) RemoveSandboxRef(name, sandbox string) error {
	return s.update(func(volumes []VolumeInfo) ([]VolumeInfo, bool, error) {
		for i, v := range volumes {
			if v.Name != name {
				continue
			}
			refs := v.SandboxRefs[:0]
			for _, ref := range v.SandboxRefs {
				if ref != sandbox {
					refs = append(refs, ref)
				}
			}
			v.SandboxRefs = refs
			volumes[i] = v
			return volumes, true, nil
		}
		return nil, false, fmt.Errorf("no volume found with name: %s", name)
	})
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
