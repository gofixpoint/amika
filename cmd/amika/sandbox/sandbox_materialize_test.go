package sandboxcmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
)

func TestGenerateRWCopyFileMountName(t *testing.T) {
	name := generateRWCopyFileMountName("my-sandbox", "/home/amika/.config/file.yaml")
	if !strings.HasPrefix(name, "amika-rwcopy-file-my-sandbox-home-amika--config-file-yaml-") {
		t.Fatalf("unexpected name: %s", name)
	}
}

func TestCopyFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "source.txt")
	dst := filepath.Join(dir, "dest.txt")
	content := []byte("hello world")

	if err := os.WriteFile(src, content, 0o640); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile failed: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("failed to read dest: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("content = %q, want %q", got, content)
	}

	dstInfo, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("failed to stat dest: %v", err)
	}
	if dstInfo.Mode().Perm() != 0o640 {
		t.Fatalf("permissions = %o, want %o", dstInfo.Mode().Perm(), 0o640)
	}
}

func TestMaterializeRWCopyMounts_Passthrough(t *testing.T) {
	dir := t.TempDir()
	volumeStore := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fileMountStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	input := []sandbox.MountBinding{
		{Type: "bind", Source: "/host/src", Target: "/workspace", Mode: "ro"},
		{Type: "volume", Volume: "vol1", Target: "/data", Mode: "rw"},
	}

	runtimeMounts, rb, err := materializeRWCopyMounts(input, "test-sb", volumeStore, fileMountStore, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runtimeMounts) != 2 {
		t.Fatalf("expected 2 mounts, got %d", len(runtimeMounts))
	}
	if runtimeMounts[0].Source != "/host/src" || runtimeMounts[1].Volume != "vol1" {
		t.Fatalf("mounts not passed through unchanged: %+v", runtimeMounts)
	}

	rb.Rollback()
}

func TestMaterializeRWCopyMounts_FileRWCopy(t *testing.T) {
	dir := t.TempDir()
	volumeStore := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fileMountStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	fileMountsBaseDir := filepath.Join(dir, "file-mounts")
	if err := os.MkdirAll(fileMountsBaseDir, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	srcFile := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(srcFile, []byte("key: value"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	input := []sandbox.MountBinding{
		{Type: "bind", Source: srcFile, Target: "/app/config.yaml", Mode: "rwcopy"},
	}

	runtimeMounts, rb, err := materializeRWCopyMounts(input, "test-sb", volumeStore, fileMountStore, fileMountsBaseDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runtimeMounts) != 1 {
		t.Fatalf("expected 1 runtime mount, got %d", len(runtimeMounts))
	}

	m := runtimeMounts[0]
	if m.Type != "bind" {
		t.Fatalf("type = %q, want bind", m.Type)
	}
	if m.Mode != "rw" {
		t.Fatalf("mode = %q, want rw", m.Mode)
	}
	if m.SnapshotFrom != srcFile {
		t.Fatalf("snapshot_from = %q, want %q", m.SnapshotFrom, srcFile)
	}

	if _, err := os.Stat(m.Source); err != nil {
		t.Fatalf("copied file does not exist at %q: %v", m.Source, err)
	}

	mounts, err := fileMountStore.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(mounts) != 1 {
		t.Fatalf("expected 1 file mount store entry, got %d", len(mounts))
	}

	rb.Rollback()
}

func TestMaterializeRWCopyMounts_Disarm(t *testing.T) {
	dir := t.TempDir()
	volumeStore := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fileMountStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	fileMountsBaseDir := filepath.Join(dir, "file-mounts")
	if err := os.MkdirAll(fileMountsBaseDir, 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	srcFile := filepath.Join(dir, "secret.yaml")
	if err := os.WriteFile(srcFile, []byte("token: abc"), 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	input := []sandbox.MountBinding{
		{Type: "bind", Source: srcFile, Target: "/app/secret.yaml", Mode: "rwcopy"},
	}

	runtimeMounts, rb, err := materializeRWCopyMounts(input, "test-sb", volumeStore, fileMountStore, fileMountsBaseDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	rb.Disarm()
	rb.Rollback()

	if _, err := os.Stat(runtimeMounts[0].Source); err != nil {
		t.Fatalf("file should still exist after Disarm+Rollback: %v", err)
	}
	mounts, err := fileMountStore.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(mounts) != 1 {
		t.Fatalf("store entry should still exist after Disarm+Rollback, got %d entries", len(mounts))
	}
}
