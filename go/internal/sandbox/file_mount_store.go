package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
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
	lines, err := marshalJSONL(mounts, "file mount info")
	if err != nil {
		return err
	}
	return writeJSONLAtomic(s.filePath, lines)
}

// update runs fn over the current entries while holding the store's advisory
// lock and atomically writes the result back, so concurrent processes cannot
// drop each other's changes through last-writer-wins. A false changed skips
// the write.
func (s *fileFileMountStore) update(fn func(mounts []FileMountInfo) ([]FileMountInfo, bool, error)) error {
	lock, err := lockStore(s.filePath)
	if err != nil {
		return err
	}
	defer lock.Close()

	mounts, err := s.readAll()
	if err != nil {
		return err
	}
	updated, changed, err := fn(mounts)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	return s.writeAll(updated)
}

func (s *fileFileMountStore) Save(info FileMountInfo) error {
	return s.update(func(mounts []FileMountInfo) ([]FileMountInfo, bool, error) {
		for i, m := range mounts {
			if m.Name == info.Name {
				mounts[i] = info
				return mounts, true, nil
			}
		}
		return append(mounts, info), true, nil
	})
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
	return s.update(func(mounts []FileMountInfo) ([]FileMountInfo, bool, error) {
		var filtered []FileMountInfo
		for _, m := range mounts {
			if m.Name != name {
				filtered = append(filtered, m)
			}
		}

		if len(filtered) == len(mounts) {
			return mounts, false, nil
		}
		return filtered, true, nil
	})
}

func (s *fileFileMountStore) List() ([]FileMountInfo, error) {
	return s.readAll()
}

func (s *fileFileMountStore) AddSandboxRef(name, sandbox string) error {
	return s.update(func(mounts []FileMountInfo) ([]FileMountInfo, bool, error) {
		for i, m := range mounts {
			if m.Name != name {
				continue
			}
			if !slices.Contains(m.SandboxRefs, sandbox) {
				m.SandboxRefs = append(m.SandboxRefs, sandbox)
				mounts[i] = m
			}
			return mounts, true, nil
		}
		return nil, false, fmt.Errorf("no file mount found with name: %s", name)
	})
}

func (s *fileFileMountStore) RemoveSandboxRef(name, sandbox string) error {
	return s.update(func(mounts []FileMountInfo) ([]FileMountInfo, bool, error) {
		for i, m := range mounts {
			if m.Name != name {
				continue
			}
			refs := m.SandboxRefs[:0]
			for _, ref := range m.SandboxRefs {
				if ref != sandbox {
					refs = append(refs, ref)
				}
			}
			m.SandboxRefs = refs
			mounts[i] = m
			return mounts, true, nil
		}
		return nil, false, fmt.Errorf("no file mount found with name: %s", name)
	})
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
