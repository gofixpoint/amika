package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// TestStore_ConcurrentSavesKeepAllEntries drives concurrent Save calls for
// distinct names through one store. Each Save is a read-modify-write cycle, so
// without the advisory lock the goroutines overwrite each other's changes and
// the final file silently loses entries.
func TestStore_ConcurrentSavesKeepAllEntries(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "sandboxes.jsonl"))

	const n = 32
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			info := Info{Name: fmt.Sprintf("sb-%02d", i), Provider: "docker"}
			if err := store.Save(info); err != nil {
				t.Errorf("Save sb-%02d: %v", i, err)
			}
		}()
	}
	wg.Wait()

	sandboxes, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sandboxes) != n {
		t.Fatalf("List returned %d sandboxes, want %d", len(sandboxes), n)
	}
}

// TestStore_ConcurrentSavesAndRemoves mixes adds and removes so the final
// state must reflect both sides of the interleaving, not whichever writer
// happened to flush last.
func TestStore_ConcurrentSavesAndRemoves(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "sandboxes.jsonl"))

	const n = 16
	for i := range n {
		if err := store.Save(Info{Name: fmt.Sprintf("gone-%02d", i)}); err != nil {
			t.Fatalf("seed Save: %v", err)
		}
	}

	var wg sync.WaitGroup
	for i := range n {
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := store.Save(Info{Name: fmt.Sprintf("kept-%02d", i)}); err != nil {
				t.Errorf("Save kept-%02d: %v", i, err)
			}
		}()
		go func() {
			defer wg.Done()
			if err := store.Remove(fmt.Sprintf("gone-%02d", i)); err != nil {
				t.Errorf("Remove gone-%02d: %v", i, err)
			}
		}()
	}
	wg.Wait()

	sandboxes, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sandboxes) != n {
		t.Fatalf("List returned %d sandboxes, want %d", len(sandboxes), n)
	}
	for _, sb := range sandboxes {
		if len(sb.Name) > 4 && sb.Name[:4] == "gone" {
			t.Errorf("sandbox %q should have been removed", sb.Name)
		}
	}
}

// TestStore_WriteLeavesNoTempFiles verifies the atomic write cleans up its
// temp file after success.
func TestStore_WriteLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(Info{Name: "sb"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	matches, err := filepath.Glob(filepath.Join(dir, "sandboxes.jsonl.tmp-*"))
	if err != nil {
		t.Fatalf("Glob: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("leftover temp files after Save: %v", matches)
	}
}

// TestWriteJSONLAtomic_ErrorKeepsOriginalFile verifies a failed write leaves
// the previous file content intact rather than truncating it.
func TestWriteJSONLAtomic_ErrorKeepsOriginalFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "store.jsonl")
	if err := writeJSONLAtomic(path, [][]byte{[]byte(`{"name":"original"}`)}); err != nil {
		t.Fatalf("initial write: %v", err)
	}

	// Make the directory unwritable so creating the temp file fails.
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod dir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	if err := writeJSONLAtomic(path, [][]byte{[]byte(`{"name":"replacement"}`)}); err == nil {
		t.Fatal("expected write error on read-only directory")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != `{"name":"original"}`+"\n" {
		t.Fatalf("original file content changed after failed write: %q", data)
	}
}

// TestVolumeStore_ConcurrentRefUpdates drives concurrent AddSandboxRef calls
// for distinct sandboxes against one volume. Each call is a read-modify-write
// cycle, so without the lock earlier updates are lost and final SandboxRefs
// ends up shorter than the number of writers.
func TestVolumeStore_ConcurrentRefUpdates(t *testing.T) {
	dir := t.TempDir()
	store := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(VolumeInfo{Name: "vol"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	const n = 16
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.AddSandboxRef("vol", fmt.Sprintf("sb-%02d", i)); err != nil {
				t.Errorf("AddSandboxRef sb-%02d: %v", i, err)
			}
		}()
	}
	wg.Wait()

	vol, err := store.Get("vol")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(vol.SandboxRefs) != n {
		t.Fatalf("SandboxRefs has %d entries, want %d: %v", len(vol.SandboxRefs), n, vol.SandboxRefs)
	}
}

// TestFileMountStore_ConcurrentRefUpdates is the file-mount counterpart of
// TestVolumeStore_ConcurrentRefUpdates.
func TestFileMountStore_ConcurrentRefUpdates(t *testing.T) {
	dir := t.TempDir()
	store := NewFileMountStore(filepath.Join(dir, "file-mounts.jsonl"))
	if err := store.Save(FileMountInfo{Name: "fm", Type: "bind", CopyPath: "/copy"}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	const n = 16
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.AddSandboxRef("fm", fmt.Sprintf("sb-%02d", i)); err != nil {
				t.Errorf("AddSandboxRef sb-%02d: %v", i, err)
			}
		}()
	}
	wg.Wait()

	fm, err := store.Get("fm")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(fm.SandboxRefs) != n {
		t.Fatalf("SandboxRefs has %d entries, want %d: %v", len(fm.SandboxRefs), n, fm.SandboxRefs)
	}
}

// TestStore_RefUpdateOnMissingEntry pins the not-found error message that
// AddSandboxRef previously surfaced through Get.
func TestRefUpdateOnMissingEntry(t *testing.T) {
	dir := t.TempDir()
	volumes := NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := volumes.AddSandboxRef("missing", "sb"); err == nil {
		t.Fatal("expected error adding ref to missing volume")
	}
	mounts := NewFileMountStore(filepath.Join(dir, "file-mounts.jsonl"))
	if err := mounts.AddSandboxRef("missing", "sb"); err == nil {
		t.Fatal("expected error adding ref to missing file mount")
	}
}
