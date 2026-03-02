package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
)

func TestDeleteTrackedVolume_InUseRequiresForce(t *testing.T) {
	store := sandbox.NewVolumeStore(filepath.Join(t.TempDir(), "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-a"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	err := deleteTrackedVolume(store, "vol-1", false, func(string) error { return nil })
	if err == nil {
		t.Fatal("expected in-use error")
	}
	if !strings.Contains(err.Error(), "use --force") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeleteTrackedVolume_ForceDeletes(t *testing.T) {
	store := sandbox.NewVolumeStore(filepath.Join(t.TempDir(), "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-a"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	called := 0
	err := deleteTrackedVolume(store, "vol-1", true, func(name string) error {
		called++
		if name != "vol-1" {
			t.Fatalf("unexpected volume name: %s", name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("deleteTrackedVolume failed: %v", err)
	}
	if called != 1 {
		t.Fatalf("removeVolumeFn called %d times, want 1", called)
	}
	if _, err := store.Get("vol-1"); err == nil {
		t.Fatal("volume should be removed from state")
	}
}

func TestVolumeListCmd_PrintsTrackedVolumes(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)

	store := sandbox.NewVolumeStore(filepath.Join(stateDir, "volumes.jsonl"))
	_ = store.Save(sandbox.VolumeInfo{
		Name:       "vol-1",
		CreatedAt:  "2026-01-02T00:00:00Z",
		SourcePath: "/host/data",
		SandboxRefs: []string{
			"sb-a",
		},
	})

	buf := &bytes.Buffer{}
	volumeListCmd.SetOut(buf)
	volumeListCmd.SetErr(buf)

	if err := volumeListCmd.RunE(volumeListCmd, nil); err != nil {
		t.Fatalf("volume list failed: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "vol-1") {
		t.Fatalf("expected volume name in output, got:\n%s", out)
	}
	if !strings.Contains(out, "TYPE") {
		t.Fatalf("expected TYPE header in output, got:\n%s", out)
	}
	if !strings.Contains(out, "directory") {
		t.Fatalf("expected directory type in output, got:\n%s", out)
	}
	if !strings.Contains(out, "yes") {
		t.Fatalf("expected in-use marker in output, got:\n%s", out)
	}
	if !strings.Contains(out, "sb-a") {
		t.Fatalf("expected sandbox refs in output, got:\n%s", out)
	}
}

func TestVolumeListCmd_PrintsBothTypes(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)

	volStore := sandbox.NewVolumeStore(filepath.Join(stateDir, "volumes.jsonl"))
	_ = volStore.Save(sandbox.VolumeInfo{
		Name:       "vol-1",
		CreatedAt:  "2026-01-01T00:00:00Z",
		SourcePath: "/host/data",
	})

	fmStore := sandbox.NewFileMountStore(filepath.Join(stateDir, "rwcopy-mounts.jsonl"))
	_ = fmStore.Save(sandbox.FileMountInfo{
		Name:       "fm-1",
		Type:       "file",
		CreatedAt:  "2026-01-02T00:00:00Z",
		SourcePath: "/host/config.yaml",
		CopyPath:   "/state/rwcopy-mounts.d/fm-1/config.yaml",
	})

	buf := &bytes.Buffer{}
	volumeListCmd.SetOut(buf)
	volumeListCmd.SetErr(buf)

	if err := volumeListCmd.RunE(volumeListCmd, nil); err != nil {
		t.Fatalf("volume list failed: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "directory") {
		t.Fatalf("expected directory type in output, got:\n%s", out)
	}
	if !strings.Contains(out, "file") {
		t.Fatalf("expected file type in output, got:\n%s", out)
	}
	if !strings.Contains(out, "vol-1") {
		t.Fatalf("expected vol-1 in output, got:\n%s", out)
	}
	if !strings.Contains(out, "fm-1") {
		t.Fatalf("expected fm-1 in output, got:\n%s", out)
	}
}

func TestDeleteTrackedFileMount_InUseRequiresForce(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	if err := store.Save(sandbox.FileMountInfo{
		Name:        "fm-1",
		CopyPath:    filepath.Join(dir, "fm-1", "file.yaml"),
		SandboxRefs: []string{"sb-a"},
	}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	err := deleteTrackedFileMount(store, "fm-1", false)
	if err == nil {
		t.Fatal("expected in-use error")
	}
	if !strings.Contains(err.Error(), "use --force") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDeleteTrackedFileMount_ForceDeletes(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	copyDir := filepath.Join(dir, "fm-1")
	if err := os.MkdirAll(copyDir, 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	copyPath := filepath.Join(copyDir, "file.yaml")
	if err := os.WriteFile(copyPath, []byte("data"), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	if err := store.Save(sandbox.FileMountInfo{
		Name:        "fm-1",
		CopyPath:    copyPath,
		SandboxRefs: []string{"sb-a"},
	}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if err := deleteTrackedFileMount(store, "fm-1", true); err != nil {
		t.Fatalf("deleteTrackedFileMount failed: %v", err)
	}
	if _, err := store.Get("fm-1"); err == nil {
		t.Fatal("file mount should be removed from state")
	}
	if _, err := os.Stat(copyDir); !os.IsNotExist(err) {
		t.Fatal("copy directory should have been removed")
	}
}

func TestVolumeDeleteAliases(t *testing.T) {
	if !slices.Contains(volumeDeleteCmd.Aliases, "rm") {
		t.Fatal("volume delete command must include alias \"rm\"")
	}
	if !slices.Contains(volumeDeleteCmd.Aliases, "remove") {
		t.Fatal("volume delete command must include alias \"remove\"")
	}
}
