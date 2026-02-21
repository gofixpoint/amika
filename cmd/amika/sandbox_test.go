package main

import (
	"testing"
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
	if mounts[0].Mode != "rw" {
		t.Errorf("mode = %q, want %q", mounts[0].Mode, "rw")
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
