package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// buildAmika builds the amika binary for integration tests and returns its path.
func buildAmika(t *testing.T) string {
	t.Helper()
	binPath := filepath.Join(t.TempDir(), "amika")
	cmd := exec.Command("go", "build", "-o", binPath, "./")
	cmd.Dir = filepath.Join(findModuleRoot(t), "cmd", "amika")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("failed to build amika: %v\n%s", err, out)
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
	bin := buildAmika(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize", "--image", "ubuntu:latest",
		"--cmd", "echo hello > result.txt",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika materialize failed: %v\n%s", err, out)
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
	bin := buildAmika(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize", "--image", "ubuntu:latest",
		"--cmd", `mkdir -p "$AMIKA_SANDBOX_ROOT/output" && echo hello > "$AMIKA_SANDBOX_ROOT/output/result.txt"`,
		"--outdir", "/output",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika materialize failed: %v\n%s", err, out)
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
	bin := buildAmika(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize", "--image", "ubuntu:latest",
		"--cmd", "mkdir -p out && echo hello > out/result.txt",
		"--outdir", "out",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika materialize failed: %v\n%s", err, out)
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
	bin := buildAmika(t)
	destdir := t.TempDir()

	cmd := exec.Command(bin, "materialize", "--image", "ubuntu:latest",
		"--cmd", "pwd > sandbox-path.txt",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika materialize failed: %v\n%s", err, out)
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
	bin := buildAmika(t)
	destdir := t.TempDir()
	scriptDir := t.TempDir()
	script := filepath.Join(scriptDir, "gen.sh")

	if err := os.WriteFile(script, []byte("#!/bin/bash\necho \"$@\" > result.txt\n"), 0755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, "materialize", "--image", "ubuntu:latest",
		"--script", script,
		"--destdir", destdir,
		"--", "foo", "bar",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amika materialize failed: %v\n%s", err, out)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "foo bar\n" {
		t.Errorf("result = %q, want %q", got, "foo bar\n")
	}
}
