package main

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
)

func TestParseMountFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single mount with mode",
			flags:   []string{"/host/src:/workspace:ro"},
			wantLen: 1,
		},
		{
			name:    "single mount default mode",
			flags:   []string{"/host/src:/workspace"},
			wantLen: 1,
		},
		{
			name:    "multiple mounts",
			flags:   []string{"/a:/x:ro", "/b:/y:rw"},
			wantLen: 2,
		},
		{
			name:    "no mounts",
			flags:   nil,
			wantLen: 0,
		},
		{
			name:    "missing target",
			flags:   []string{"/host/src"},
			wantErr: true,
		},
		{
			name:    "invalid mode",
			flags:   []string{"/host/src:/workspace:xx"},
			wantErr: true,
		},
		{
			name:    "relative target rejected",
			flags:   []string{"/host/src:workspace:ro"},
			wantErr: true,
		},
		{
			name:    "duplicate target",
			flags:   []string{"/a:/workspace:ro", "/b:/workspace:rw"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mounts, err := parseMountFlags(tt.flags)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(mounts) != tt.wantLen {
				t.Errorf("expected %d mounts, got %d", tt.wantLen, len(mounts))
			}
		})
	}
}

func TestParseMountFlags_DefaultMode(t *testing.T) {
	mounts, err := parseMountFlags([]string{"/host/src:/workspace"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mounts[0].Mode != "rwcopy" {
		t.Errorf("mode = %q, want %q", mounts[0].Mode, "rwcopy")
	}
}

func TestParseMountFlags_ResolvesAbsPath(t *testing.T) {
	mounts, err := parseMountFlags([]string{"./relative:/workspace"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mounts[0].Source == "./relative" {
		t.Error("source should have been resolved to absolute path")
	}
}

func TestParseVolumeFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single volume with mode",
			flags:   []string{"vol1:/workspace:ro"},
			wantLen: 1,
		},
		{
			name:    "single volume default mode",
			flags:   []string{"vol1:/workspace"},
			wantLen: 1,
		},
		{
			name:    "missing target",
			flags:   []string{"vol1"},
			wantErr: true,
		},
		{
			name:    "empty name",
			flags:   []string{":/workspace:rw"},
			wantErr: true,
		},
		{
			name:    "invalid mode",
			flags:   []string{"vol1:/workspace:rwcopy"},
			wantErr: true,
		},
		{
			name:    "relative target rejected",
			flags:   []string{"vol1:workspace:rw"},
			wantErr: true,
		},
		{
			name:    "duplicate target",
			flags:   []string{"vol1:/workspace:ro", "vol2:/workspace:rw"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mounts, err := parseVolumeFlags(tt.flags)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(mounts) != tt.wantLen {
				t.Errorf("expected %d mounts, got %d", tt.wantLen, len(mounts))
			}
		})
	}
}

func TestValidateMountTargets_DuplicateAcrossMountAndVolume(t *testing.T) {
	bind := []sandbox.MountBinding{{Type: "bind", Source: "/host/src", Target: "/workspace", Mode: "rwcopy"}}
	vol := []sandbox.MountBinding{{Type: "volume", Volume: "vol1", Target: "/workspace", Mode: "rw"}}

	if err := validateMountTargets(bind, vol); err == nil {
		t.Fatal("expected duplicate target error")
	}
}

func TestCleanupSandboxVolumes_PreserveDefault(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", false, func(string) error {
		t.Fatal("removeVolumeFn should not be called in preserve mode")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteUnused(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	called := 0
	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(name string) error {
		called++
		if name != "vol-1" {
			t.Fatalf("unexpected volume: %s", name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if called != 1 {
		t.Fatalf("removeVolumeFn called %d times, want 1", called)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
	if _, err := store.Get("vol-1"); err == nil {
		t.Fatal("volume state entry should be removed")
	}
}

func TestCleanupSandboxVolumes_PreserveStillReferenced(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		t.Fatal("removeVolumeFn should not be called for still-referenced volume")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved (still referenced)" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 1 || info.SandboxRefs[0] != "sb-2" {
		t.Fatalf("SandboxRefs = %v, want [sb-2]", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteFailureReported(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		return fmt.Errorf("boom")
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: delete-failed: boom" {
		t.Fatalf("lines = %v", lines)
	}
}
