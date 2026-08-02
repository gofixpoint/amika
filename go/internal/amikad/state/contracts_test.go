package state

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type writeCall struct {
	path string
	data []byte
	mode fs.FileMode
}

type memoryFiles struct {
	mu         sync.Mutex
	contents   map[string][]byte
	modes      map[string]fs.FileMode
	symlinks   map[string]bool
	failWrites map[string]error
	writes     []writeCall
}

func newMemoryFiles() *memoryFiles {
	return &memoryFiles{
		contents:   make(map[string][]byte),
		modes:      make(map[string]fs.FileMode),
		symlinks:   make(map[string]bool),
		failWrites: make(map[string]error),
	}
}

func (f *memoryFiles) ReadFile(path string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.contents[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func (f *memoryFiles) Lstat(path string) (fs.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.symlinks[path] {
		return fakeFileInfo{mode: fs.ModeSymlink}, nil
	}
	data, ok := f.contents[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return fakeFileInfo{size: int64(len(data)), mode: f.modes[path]}, nil
}

func (f *memoryFiles) WriteFileAtomic(path string, data []byte, mode fs.FileMode) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes = append(f.writes, writeCall{path: path, data: append([]byte(nil), data...), mode: mode})
	if err := f.failWrites[path]; err != nil {
		return err
	}
	f.contents[path] = append([]byte(nil), data...)
	f.modes[path] = mode
	return nil
}

type fakeFileInfo struct {
	size int64
	mode fs.FileMode
}

func (fakeFileInfo) Name() string        { return "test" }
func (i fakeFileInfo) Size() int64       { return i.size }
func (i fakeFileInfo) Mode() fs.FileMode { return i.mode }
func (fakeFileInfo) ModTime() time.Time  { return time.Time{} }
func (fakeFileInfo) IsDir() bool         { return false }
func (fakeFileInfo) Sys() any            { return nil }

func TestStoreRegistersBeforeWritingSensitiveFile(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")
	tokenPath := filepath.Join(dir, "connect-token")
	files := newMemoryFiles()
	store := NewStore(manifestPath, files)

	if err := store.WriteAndRegister(
		context.Background(),
		tokenPath,
		strings.NewReader("connect-token"),
		0o600,
	); err != nil {
		t.Fatalf("WriteAndRegister: %v", err)
	}
	if len(files.writes) != 2 {
		t.Fatalf("writes = %#v, want manifest then sensitive file", files.writes)
	}
	if files.writes[0].path != manifestPath || files.writes[1].path != tokenPath {
		t.Fatalf("write order = %q then %q", files.writes[0].path, files.writes[1].path)
	}
	if files.writes[1].mode != 0o600 {
		t.Fatalf("token mode = %o, want 600", files.writes[1].mode)
	}
	assertManifestPaths(t, files.writes[0].data, []string{tokenPath})
}

func TestStoreDoesNotWriteSecretWhenManifestWriteFails(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")
	tokenPath := filepath.Join(dir, "connect-token")
	manifestErr := errors.New("manifest write failed")
	files := newMemoryFiles()
	files.failWrites[manifestPath] = manifestErr
	store := NewStore(manifestPath, files)

	err := store.WriteAndRegister(context.Background(), tokenPath, strings.NewReader("token"), 0o600)
	if !errors.Is(err, manifestErr) {
		t.Fatalf("error = %v, want manifest failure", err)
	}
	for _, call := range files.writes {
		if call.path == tokenPath {
			t.Fatalf("secret write occurred after manifest failure")
		}
	}
}

func TestStoreLeavesRegistrationWhenSensitiveWriteFails(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")
	tokenPath := filepath.Join(dir, "connect-token")
	fileErr := errors.New("file write failed")
	files := newMemoryFiles()
	files.failWrites[tokenPath] = fileErr
	store := NewStore(manifestPath, files)

	err := store.WriteAndRegister(context.Background(), tokenPath, strings.NewReader("token"), 0o600)
	if !errors.Is(err, fileErr) {
		t.Fatalf("error = %v, want file failure", err)
	}
	assertManifestPaths(t, files.contents[manifestPath], []string{tokenPath})
}

func TestStorePreservesExistingManifestEntries(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")
	oldPath := filepath.Join(dir, "old-secret")
	newPath := filepath.Join(dir, "new-secret")
	files := newMemoryFiles()
	files.contents[manifestPath], _ = json.Marshal([]string{oldPath})
	store := NewStore(manifestPath, files)

	if err := store.WriteAndRegister(context.Background(), newPath, strings.NewReader("new"), 0o600); err != nil {
		t.Fatalf("WriteAndRegister: %v", err)
	}
	assertManifestPaths(t, files.contents[manifestPath], []string{oldPath, newPath})
}

func TestStoreRejectsUnsafePaths(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")

	t.Run("relative", func(t *testing.T) {
		files := newMemoryFiles()
		store := NewStore(manifestPath, files)
		err := store.WriteAndRegister(context.Background(), "relative/token", strings.NewReader("token"), 0o600)
		if !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("error = %v, want ErrInvalidPath", err)
		}
		if len(files.writes) != 0 {
			t.Fatalf("unsafe path caused writes: %#v", files.writes)
		}
	})

	t.Run("symlink", func(t *testing.T) {
		files := newMemoryFiles()
		tokenPath := filepath.Join(dir, "token-link")
		files.symlinks[tokenPath] = true
		store := NewStore(manifestPath, files)
		err := store.WriteAndRegister(context.Background(), tokenPath, strings.NewReader("token"), 0o600)
		if !errors.Is(err, ErrSymlinkPath) {
			t.Fatalf("error = %v, want ErrSymlinkPath", err)
		}
		if len(files.writes) != 0 {
			t.Fatalf("symlink path caused writes: %#v", files.writes)
		}
	})
}

func TestStoreSerializesConcurrentManifestUpdates(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")
	files := newMemoryFiles()
	store := NewStore(manifestPath, files)
	paths := []string{
		filepath.Join(dir, "secret-a"),
		filepath.Join(dir, "secret-b"),
		filepath.Join(dir, "secret-c"),
	}

	var wg sync.WaitGroup
	errs := make(chan error, len(paths))
	for _, path := range paths {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- store.WriteAndRegister(context.Background(), path, strings.NewReader("secret"), 0o600)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent WriteAndRegister: %v", err)
		}
	}
	assertManifestPathSet(t, files.contents[manifestPath], paths)
}

func assertManifestPaths(t *testing.T, data []byte, want []string) {
	t.Helper()
	var got []string
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("manifest = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("manifest = %#v, want %#v", got, want)
		}
	}
}

func assertManifestPathSet(t *testing.T, data []byte, want []string) {
	t.Helper()
	var got []string
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	seen := make(map[string]bool, len(got))
	for _, path := range got {
		seen[path] = true
	}
	for _, path := range want {
		if !seen[path] {
			t.Fatalf("manifest %v missing %q", got, path)
		}
	}
}
