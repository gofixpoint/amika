package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

const docA = "---\ntitle: First doc\ntags: [a, b]\n---\nbody\n"
const docB = "---\ntitle: Second doc\nstatus: draft\n---\nbody\n"

// frontmatterCmd returns the registered "frontmatter" command.
func frontmatterCmd(t *testing.T) *cobra.Command {
	t.Helper()
	for _, c := range rootCmd.Commands() {
		if c.Name() == "frontmatter" {
			return c
		}
	}
	t.Fatal("frontmatter command not registered")
	return nil
}

// writeTemp writes content to a temp file and returns its path.
func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "doc.md")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	return path
}

// withStdin replaces os.Stdin with a file holding content for the duration of
// fn, restoring it afterward.
func withStdin(t *testing.T, content string, fn func()) {
	t.Helper()
	path := writeTemp(t, content)
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open stdin file: %v", err)
	}
	defer f.Close()
	old := os.Stdin
	os.Stdin = f
	defer func() { os.Stdin = old }()
	fn()
}

func TestFrontmatterCommandSingleFile(t *testing.T) {
	cmd := frontmatterCmd(t)
	var buf bytes.Buffer
	cmd.SetOut(&buf)

	if err := cmd.RunE(cmd, []string{writeTemp(t, docA)}); err != nil {
		t.Fatalf("RunE: %v", err)
	}

	want := `{"data":{"tags":["a","b"],"title":"First doc"}}` + "\n"
	if buf.String() != want {
		t.Errorf("output = %q, want %q", buf.String(), want)
	}
}

func TestFrontmatterCommandMultipleFiles(t *testing.T) {
	cmd := frontmatterCmd(t)
	var buf bytes.Buffer
	cmd.SetOut(&buf)

	args := []string{writeTemp(t, docA), writeTemp(t, docB)}
	if err := cmd.RunE(cmd, args); err != nil {
		t.Fatalf("RunE: %v", err)
	}

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2: %q", len(lines), buf.String())
	}
	// Each line must be a valid {"data": {...}} envelope.
	for i, line := range lines {
		var env struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal([]byte(line), &env); err != nil {
			t.Fatalf("line %d not valid JSON: %v", i, err)
		}
		if env.Data["title"] == nil {
			t.Errorf("line %d missing data.title: %q", i, line)
		}
	}
}

func TestFrontmatterCommandStdin(t *testing.T) {
	cmd := frontmatterCmd(t)
	var buf bytes.Buffer
	cmd.SetOut(&buf)

	// No args reads stdin; "-" also reads stdin via emitPath.
	for _, args := range [][]string{{}, {"-"}} {
		buf.Reset()
		withStdin(t, docA, func() {
			if err := cmd.RunE(cmd, args); err != nil {
				t.Fatalf("RunE(%v): %v", args, err)
			}
		})
		want := `{"data":{"tags":["a","b"],"title":"First doc"}}` + "\n"
		if buf.String() != want {
			t.Errorf("args %v: output = %q, want %q", args, buf.String(), want)
		}
	}
}

func TestFrontmatterCommandMissingFile(t *testing.T) {
	cmd := frontmatterCmd(t)
	cmd.SetOut(&bytes.Buffer{})

	err := cmd.RunE(cmd, []string{filepath.Join(t.TempDir(), "nope.md")})
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

func TestFrontmatterCommandParseError(t *testing.T) {
	cmd := frontmatterCmd(t)
	cmd.SetOut(&bytes.Buffer{})

	// File without a frontmatter block should surface a parse error naming the
	// source path.
	path := writeTemp(t, "no frontmatter here\n")
	err := cmd.RunE(cmd, []string{path})
	if err == nil {
		t.Fatal("expected parse error, got nil")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error %q should mention source path %q", err, path)
	}
}
