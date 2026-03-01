package main

import (
	"bytes"
	"path/filepath"
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
	if !strings.Contains(out, "yes") {
		t.Fatalf("expected in-use marker in output, got:\n%s", out)
	}
	if !strings.Contains(out, "sb-a") {
		t.Fatalf("expected sandbox refs in output, got:\n%s", out)
	}
}
