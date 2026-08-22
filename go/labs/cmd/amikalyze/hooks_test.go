package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHooksInstallRequiresAgent(t *testing.T) {
	_, err := runRootCommand("", "hooks", "install")
	if err == nil || !strings.Contains(err.Error(), "--agent is required") {
		t.Fatalf("hooks install error = %v", err)
	}
}

func TestHooksInstallSelectedAgent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	output, err := runRootCommand("", "hooks", "install", "--agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "Installed claude hook") {
		t.Fatalf("output = %q", output)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".codex", "hooks.json")); !os.IsNotExist(err) {
		t.Fatalf("Codex hook unexpectedly exists: %v", err)
	}
}
