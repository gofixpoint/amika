package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveSandboxOutdir(t *testing.T) {
	tests := []struct {
		name        string
		outdir      string
		sandboxRoot string
		workdir     string
		want        string
	}{
		{
			name:        "empty returns workdir",
			outdir:      "",
			sandboxRoot: "/tmp/wisp-sandbox-abc",
			workdir:     "/tmp/wisp-sandbox-abc/home/wisp/workspace",
			want:        "/tmp/wisp-sandbox-abc/home/wisp/workspace",
		},
		{
			name:        "absolute path resolved relative to sandbox root",
			outdir:      "/output",
			sandboxRoot: "/tmp/wisp-sandbox-abc",
			workdir:     "/tmp/wisp-sandbox-abc/home/wisp/workspace",
			want:        "/tmp/wisp-sandbox-abc/output",
		},
		{
			name:        "relative path resolved relative to workdir",
			outdir:      "output",
			sandboxRoot: "/tmp/wisp-sandbox-abc",
			workdir:     "/tmp/wisp-sandbox-abc/home/wisp/workspace",
			want:        "/tmp/wisp-sandbox-abc/home/wisp/workspace/output",
		},
		{
			name:        "absolute nested path",
			outdir:      "/var/data/out",
			sandboxRoot: "/tmp/wisp-sandbox-abc",
			workdir:     "/tmp/wisp-sandbox-abc/home/wisp/workspace",
			want:        "/tmp/wisp-sandbox-abc/var/data/out",
		},
		{
			name:        "relative nested path",
			outdir:      "sub/dir",
			sandboxRoot: "/tmp/wisp-sandbox-abc",
			workdir:     "/tmp/wisp-sandbox-abc/home/wisp/workspace",
			want:        "/tmp/wisp-sandbox-abc/home/wisp/workspace/sub/dir",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveSandboxOutdir(tt.outdir, tt.sandboxRoot, tt.workdir)
			if got != tt.want {
				t.Errorf("resolveSandboxOutdir(%q, %q, %q) = %q, want %q",
					tt.outdir, tt.sandboxRoot, tt.workdir, got, tt.want)
			}
		})
	}
}

// buildWisp builds the wisp binary for integration tests and returns its path.
func buildWisp(t *testing.T) string {
	t.Helper()
	binPath := filepath.Join(t.TempDir(), "wisp")
	cmd := exec.Command("go", "build", "-o", binPath, "./")
	cmd.Dir = filepath.Join(findModuleRoot(t), "cmd", "wisp")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build wisp: %v\n%s", err, out)
	}
	return binPath
}

// findModuleRoot walks up from the test file's directory to find go.mod.
func findModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find module root (go.mod)")
		}
		dir = parent
	}
}

func TestTopMaterialize_CmdDefaultOutdir(t *testing.T) {
	bin := buildWisp(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize",
		"--cmd", "echo hello > result.txt",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wisp materialize failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "hello\n" {
		t.Errorf("result = %q, want %q", got, "hello\n")
	}
}

func TestTopMaterialize_CmdAbsoluteOutdir(t *testing.T) {
	bin := buildWisp(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize",
		"--cmd", `mkdir -p "$WISP_SANDBOX_ROOT/output" && echo hello > "$WISP_SANDBOX_ROOT/output/result.txt"`,
		"--outdir", "/output",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wisp materialize failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "hello\n" {
		t.Errorf("result = %q, want %q", got, "hello\n")
	}
}

func TestTopMaterialize_CmdRelativeOutdir(t *testing.T) {
	bin := buildWisp(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize",
		"--cmd", "mkdir -p out && echo hello > out/result.txt",
		"--outdir", "out",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wisp materialize failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "hello\n" {
		t.Errorf("result = %q, want %q", got, "hello\n")
	}
}

func TestTopMaterialize_SandboxCleanup(t *testing.T) {
	bin := buildWisp(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize",
		"--cmd", "pwd > sandbox-path.txt",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wisp materialize failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "sandbox-path.txt"))
	if err != nil {
		t.Fatalf("failed to read sandbox path: %v", err)
	}

	sandboxWorkdirPath := strings.TrimRight(string(data), "\n")

	// The sandbox directory should have been cleaned up
	if _, err := os.Stat(sandboxWorkdirPath); !os.IsNotExist(err) {
		t.Errorf("sandbox workdir %q still exists after execution", sandboxWorkdirPath)
	}
}

func TestTopMaterialize_Script(t *testing.T) {
	bin := buildWisp(t)
	destdir := t.TempDir()
	scriptDir := t.TempDir()
	script := filepath.Join(scriptDir, "gen.sh")

	if err := os.WriteFile(script, []byte("#!/bin/bash\necho \"$@\" > result.txt\n"), 0755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, "materialize",
		"--script", script,
		"--destdir", destdir,
		"--", "foo", "bar",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wisp materialize failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "foo bar\n" {
		t.Errorf("result = %q, want %q", got, "foo bar\n")
	}
}
