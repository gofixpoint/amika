package materialize

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRun_ScriptNoArgs(t *testing.T) {
	tmpDir := t.TempDir()
	workdir := filepath.Join(tmpDir, "work")
	outdir := filepath.Join(tmpDir, "out")
	destdir := filepath.Join(tmpDir, "dest")
	script := filepath.Join(tmpDir, "script.sh")

	// Script writes a file to outdir
	if err := os.WriteFile(script, []byte("#!/bin/bash\necho hello > "+outdir+"/result.txt\n"), 0755); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		Script:  script,
		Workdir: workdir,
		Outdir:  outdir,
		Destdir: destdir,
	}

	if err := Run(opts); err != nil {
		t.Fatalf("Run() error: %v", err)
	}

	// Verify output was materialized
	data, err := os.ReadFile(filepath.Join(destdir, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "hello\n" {
		t.Errorf("result = %q, want %q", got, "hello\n")
	}
}

func TestRun_ScriptWithArgs(t *testing.T) {
	tmpDir := t.TempDir()
	workdir := filepath.Join(tmpDir, "work")
	outdir := filepath.Join(tmpDir, "out")
	destdir := filepath.Join(tmpDir, "dest")
	script := filepath.Join(tmpDir, "script.sh")

	// Script writes its arguments to outdir
	if err := os.WriteFile(script, []byte("#!/bin/bash\necho \"$@\" > "+outdir+"/args.txt\n"), 0755); err != nil {
		t.Fatal(err)
	}

	opts := Options{
		Script:     script,
		ScriptArgs: []string{"foo", "bar", "--verbose"},
		Workdir:    workdir,
		Outdir:     outdir,
		Destdir:    destdir,
	}

	if err := Run(opts); err != nil {
		t.Fatalf("Run() error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "args.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "foo bar --verbose\n" {
		t.Errorf("result = %q, want %q", got, "foo bar --verbose\n")
	}
}

func TestRun_CmdMode(t *testing.T) {
	tmpDir := t.TempDir()
	workdir := filepath.Join(tmpDir, "work")
	outdir := filepath.Join(tmpDir, "out")
	destdir := filepath.Join(tmpDir, "dest")

	opts := Options{
		Cmd:     "echo cmd-output > " + outdir + "/cmd-result.txt",
		Workdir: workdir,
		Outdir:  outdir,
		Destdir: destdir,
	}

	if err := Run(opts); err != nil {
		t.Fatalf("Run() error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(destdir, "cmd-result.txt"))
	if err != nil {
		t.Fatalf("failed to read result: %v", err)
	}
	if got := string(data); got != "cmd-output\n" {
		t.Errorf("result = %q, want %q", got, "cmd-output\n")
	}
}

func TestRun_ErrorNeitherScriptNorCmd(t *testing.T) {
	opts := Options{
		Workdir: "/tmp",
		Outdir:  "/tmp",
		Destdir: "/tmp",
	}
	err := Run(opts)
	if err == nil {
		t.Fatal("expected error when neither Script nor Cmd is set")
	}
	want := "exactly one of Script or Cmd must be set"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
}

func TestRun_ErrorBothScriptAndCmd(t *testing.T) {
	opts := Options{
		Script:  "/bin/echo",
		Cmd:     "echo hi",
		Workdir: "/tmp",
		Outdir:  "/tmp",
		Destdir: "/tmp",
	}
	err := Run(opts)
	if err == nil {
		t.Fatal("expected error when both Script and Cmd are set")
	}
	want := "exactly one of Script or Cmd must be set"
	if err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
}

func TestRun_ScriptDoesNotExist(t *testing.T) {
	tmpDir := t.TempDir()
	opts := Options{
		Script:  filepath.Join(tmpDir, "nonexistent.sh"),
		Workdir: filepath.Join(tmpDir, "work"),
		Outdir:  filepath.Join(tmpDir, "out"),
		Destdir: filepath.Join(tmpDir, "dest"),
	}
	err := Run(opts)
	if err == nil {
		t.Fatal("expected error for nonexistent script")
	}
}
