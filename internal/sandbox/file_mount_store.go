package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

// FileMountInfo represents a tracked file-based rwcopy mount.
type FileMountInfo struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	CreatedAt   string   `json:"createdAt"`
	CreatedBy   string   `json:"createdBy,omitempty"`
	SourcePath  string   `json:"sourcePath,omitempty"`
	CopyPath    string   `json:"copyPath"`
	SandboxRefs []string `json:"sandboxRefs,omitempty"`
}

// FileMountStore manages file mount state persistence.
type FileMountStore interface {
	Save(info FileMountInfo) error
	Get(name string) (FileMountInfo, error)
	Remove(name string) error
	List() ([]FileMountInfo, error)
	AddSandboxRef(name, sandbox string) error
	RemoveSandboxRef(name, sandbox string) error
	FileMountsForSandbox(sandbox string) ([]FileMountInfo, error)
	IsInUse(name string) (bool, error)
}

type fileFileMountStore struct {
	filePath string
}

// NewFileMountStore creates a FileMountStore backed by the provided JSONL file path.
func NewFileMountStore(filePath string) FileMountStore {
	return &fileFileMountStore{filePath: filePath}
}

func (s *fileFileMountStore) readAll() ([]FileMountInfo, error) {
	f, err := os.Open(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to open file mounts file: %w", err)
	}
	defer f.Close()

	var mounts []FileMountInfo
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var info FileMountInfo
		if err := json.Unmarshal([]byte(line), &info); err != nil {
			continue
		}
		mounts = append(mounts, info)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read file mounts file: %w", err)
	}
	return mounts, nil
}

func (s *fileFileMountStore) writeAll(mounts []FileMountInfo) error {
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0755); err != nil {
		return fmt.Errorf("failed to create storage directory: %w", err)
	}

	f, err := os.Create(s.filePath)
	if err != nil {
		return fmt.Errorf("failed to create file mounts file: %w", err)
	}
	defer f.Close()

	for _, info := range mounts {
		data, err := json.Marshal(info)
		if err != nil {
			return fmt.Errorf("failed to marshal file mount info: %w", err)
		}
		if _, err := f.Write(data); err != nil {
			return fmt.Errorf("failed to write file mount info: %w", err)
		}
		if _, err := f.WriteString("\n"); err != nil {
			return fmt.Errorf("failed to write newline: %w", err)
		}
	}

	return nil
}

func (s *fileFileMountStore) Save(info FileMountInfo) error {
	mounts, err := s.readAll()
	if err != nil {
		return err
	}

	found := false
	for i := range mounts {
		if mounts[i].Name == info.Name {
			mounts[i] = info
			found = true
			break
		}
	}
	if !found {
		mounts = append(mounts, info)
	}

	return s.writeAll(mounts)
}

func (s *fileFileMountStore) Get(name string) (FileMountInfo, error) {
	mounts, err := s.readAll()
	if err != nil {
		return FileMountInfo{}, err
	}

	for _, m := range mounts {
		if m.Name == name {
			return m, nil
		}
	}
	return FileMountInfo{}, fmt.Errorf("no file mount found with name: %s", name)
}

func (s *fileFileMountStore) Remove(name string) error {
	mounts, err := s.readAll()
	if err != nil {
		return err
	}

	var filtered []FileMountInfo
	for _, m := range mounts {
		if m.Name != name {
			filtered = append(filtered, m)
		}
	}

	if len(filtered) == len(mounts) {
		return nil
	}

	return s.writeAll(filtered)
}

func (s *fileFileMountStore) List() ([]FileMountInfo, error) {
	return s.readAll()
}

func (s *fileFileMountStore) AddSandboxRef(name, sandbox string) error {
	info, err := s.Get(name)
	if err != nil {
		return err
	}

	if !slices.Contains(info.SandboxRefs, sandbox) {
		info.SandboxRefs = append(info.SandboxRefs, sandbox)
	}
	return s.Save(info)
}

func (s *fileFileMountStore) RemoveSandboxRef(name, sandbox string) error {
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

func (s *fileFileMountStore) FileMountsForSandbox(sandbox string) ([]FileMountInfo, error) {
	mounts, err := s.readAll()
	if err != nil {
		return nil, err
	}

	var result []FileMountInfo
	for _, m := range mounts {
		if slices.Contains(m.SandboxRefs, sandbox) {
			result = append(result, m)
		}
	}
	return result, nil
}

func (s *fileFileMountStore) IsInUse(name string) (bool, error) {
	info, err := s.Get(name)
	if err != nil {
		return false, err
	}
	return len(info.SandboxRefs) > 0, nil
}
