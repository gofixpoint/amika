package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveSandboxOutdir(t *testing.T) {
	tests := []struct {
		name    string
		root    string
		outdir  string
		workdir string
		wantW   string // expected workdir
		wantO   string // expected outdir
	}{
		{
			name:    "empty outdir with absolute workdir",
			root:    "/tmp/sb",
			outdir:  "",
			workdir: "/home/clawbox/workspace",
			wantW:   "/tmp/sb/home/clawbox/workspace",
			wantO:   "/tmp/sb/home/clawbox/workspace",
		},
		{
			name:    "absolute outdir",
			root:    "/tmp/sb",
			outdir:  "/output",
			workdir: "/home/clawbox/workspace",
			wantW:   "/tmp/sb/home/clawbox/workspace",
			wantO:   "/tmp/sb/output",
		},
		{
			name:    "relative outdir",
			root:    "/tmp/sb",
			outdir:  "out",
			workdir: "/home/clawbox/workspace",
			wantW:   "/tmp/sb/home/clawbox/workspace",
			wantO:   "/tmp/sb/home/clawbox/workspace/out",
		},
		{
			name:    "absolute nested outdir",
			root:    "/tmp/sb",
			outdir:  "/var/data/out",
			workdir: "/home/clawbox/workspace",
			wantW:   "/tmp/sb/home/clawbox/workspace",
			wantO:   "/tmp/sb/var/data/out",
		},
		{
			name:    "relative nested outdir",
			root:    "/tmp/sb",
			outdir:  "sub/dir",
			workdir: "/home/clawbox/workspace",
			wantW:   "/tmp/sb/home/clawbox/workspace",
			wantO:   "/tmp/sb/home/clawbox/workspace/sub/dir",
		},
		{
			name:    "relative workdir nested under sandbox root",
			root:    "/tmp/sb",
			outdir:  "",
			workdir: "work",
			wantW:   "/tmp/sb/work",
			wantO:   "/tmp/sb/work",
		},
		{
			name:    "relative workdir with relative outdir",
			root:    "/tmp/sb",
			outdir:  "out",
			workdir: "work",
			wantW:   "/tmp/sb/work",
			wantO:   "/tmp/sb/work/out",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveSandboxOutdir(tt.root, tt.outdir, tt.workdir)
			if got.GetWorkdir() != tt.wantW {
				t.Errorf("workdir = %q, want %q", got.GetWorkdir(), tt.wantW)
			}
			if got.GetOutdir() != tt.wantO {
				t.Errorf("outdir = %q, want %q", got.GetOutdir(), tt.wantO)
			}
			if got.GetRoot() != tt.root {
				t.Errorf("root = %q, want %q", got.GetRoot(), tt.root)
			}
		})
	}
}

func TestNewTmpDirSandboxPaths_DefaultWorkdir(t *testing.T) {
	sb, err := NewTmpDirSandboxPaths("", "")
	if err != nil {
		t.Fatalf("NewTmpDirSandboxPaths failed: %v", err)
	}
	defer sb.Cleanup()

	if !strings.HasSuffix(sb.GetWorkdir(), "/home/clawbox/workspace") {
		t.Errorf("workdir %q should end with /home/clawbox/workspace", sb.GetWorkdir())
	}

	if !strings.HasPrefix(sb.GetWorkdir(), sb.GetRoot()) {
		t.Errorf("workdir %q should be under root %q", sb.GetWorkdir(), sb.GetRoot())
	}

	// Verify workdir was created on disk
	info, err := os.Stat(sb.GetWorkdir())
	if err != nil {
		t.Fatalf("workdir %q should exist on disk: %v", sb.GetWorkdir(), err)
	}
	if !info.IsDir() {
		t.Errorf("workdir %q should be a directory", sb.GetWorkdir())
	}

	// Verify cleanup removes root
	root := sb.GetRoot()
	if err := sb.Cleanup(); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Errorf("root %q should not exist after Cleanup", root)
	}
}

func TestNewTmpDirSandboxPaths_CustomWorkdir(t *testing.T) {
	sb, err := NewTmpDirSandboxPaths("/custom/workdir", "")
	if err != nil {
		t.Fatalf("NewTmpDirSandboxPaths failed: %v", err)
	}
	defer sb.Cleanup()

	expected := filepath.Join(sb.GetRoot(), "custom/workdir")
	if sb.GetWorkdir() != expected {
		t.Errorf("workdir = %q, want %q", sb.GetWorkdir(), expected)
	}

	// Verify workdir was created on disk
	info, err := os.Stat(sb.GetWorkdir())
	if err != nil {
		t.Fatalf("workdir %q should exist on disk: %v", sb.GetWorkdir(), err)
	}
	if !info.IsDir() {
		t.Errorf("workdir %q should be a directory", sb.GetWorkdir())
	}
}

func TestNewTmpDirSandboxPaths_OutdirVariants(t *testing.T) {
	t.Run("default outdir equals workdir", func(t *testing.T) {
		sb, err := NewTmpDirSandboxPaths("", "")
		if err != nil {
			t.Fatalf("NewTmpDirSandboxPaths failed: %v", err)
		}
		defer sb.Cleanup()

		if sb.GetOutdir() != sb.GetWorkdir() {
			t.Errorf("outdir = %q, want workdir %q", sb.GetOutdir(), sb.GetWorkdir())
		}
	})

	t.Run("absolute outdir nested under root", func(t *testing.T) {
		sb, err := NewTmpDirSandboxPaths("", "/output")
		if err != nil {
			t.Fatalf("NewTmpDirSandboxPaths failed: %v", err)
		}
		defer sb.Cleanup()

		expected := filepath.Join(sb.GetRoot(), "output")
		if sb.GetOutdir() != expected {
			t.Errorf("outdir = %q, want %q", sb.GetOutdir(), expected)
		}
	})

	t.Run("relative outdir nested under workdir", func(t *testing.T) {
		sb, err := NewTmpDirSandboxPaths("", "out")
		if err != nil {
			t.Fatalf("NewTmpDirSandboxPaths failed: %v", err)
		}
		defer sb.Cleanup()

		expected := filepath.Join(sb.GetWorkdir(), "out")
		if sb.GetOutdir() != expected {
			t.Errorf("outdir = %q, want %q", sb.GetOutdir(), expected)
		}
	})
}

func TestCleanup(t *testing.T) {
	sb, err := NewTmpDirSandboxPaths("", "")
	if err != nil {
		t.Fatalf("NewTmpDirSandboxPaths failed: %v", err)
	}

	root := sb.GetRoot()

	// Verify root exists
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("root %q should exist: %v", root, err)
	}

	// Cleanup
	if err := sb.Cleanup(); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}

	// Verify root is gone
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Errorf("root %q should not exist after Cleanup", root)
	}
}
