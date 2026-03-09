package amikaconfig_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/amikaconfig"
)

func TestLoadConfig_NotExist(t *testing.T) {
	dir := t.TempDir()
	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg != nil {
		t.Fatalf("expected nil config, got %+v", cfg)
	}
}

func TestLoadConfig_ValidConfig(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `[lifecycle]
setup_script = "scripts/setup.sh"
`
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Lifecycle.SetupScript != "scripts/setup.sh" {
		t.Errorf("expected setup_script %q, got %q", "scripts/setup.sh", cfg.Lifecycle.SetupScript)
	}
}

func TestLoadConfig_MalformedTOML(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte("not = valid [[["), 0644); err != nil {
		t.Fatal(err)
	}

	_, err := amikaconfig.LoadConfig(dir)
	if err == nil {
		t.Fatal("expected error for malformed TOML, got nil")
	}
}

func TestLoadConfig_EmptyLifecycleSection(t *testing.T) {
	dir := t.TempDir()
	amikaDir := filepath.Join(dir, ".amika")
	if err := os.Mkdir(amikaDir, 0755); err != nil {
		t.Fatal(err)
	}
	content := `[lifecycle]
`
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cfg, err := amikaconfig.LoadConfig(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Lifecycle.SetupScript != "" {
		t.Errorf("expected empty setup_script, got %q", cfg.Lifecycle.SetupScript)
	}
}
