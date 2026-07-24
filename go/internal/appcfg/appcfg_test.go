package appcfg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

func newPaths(t *testing.T) (basedir.Paths, string) {
	t.Helper()
	home := t.TempDir()
	return basedir.New(home), home
}

func TestUpsertClaudeSSHConfigCreatesFile(t *testing.T) {
	paths, home := newPaths(t)
	host := ClaudeSSHHost{ID: "amika-abc", Name: "Amika: my-sandbox", SSHHost: "amika-abc", StartDirectory: "/home/amika/workspace/repo"}

	changed, err := UpsertClaudeSSHConfig(paths, host)
	if err != nil {
		t.Fatalf("UpsertClaudeSSHConfig: %v", err)
	}
	if !changed {
		t.Fatalf("expected changed=true when creating the file")
	}

	var doc struct {
		SSHConfigs []claudeSSHConfigEntry `json:"sshConfigs"`
	}
	readJSON(t, filepath.Join(home, ".claude", "settings.json"), &doc)
	if len(doc.SSHConfigs) != 1 {
		t.Fatalf("expected 1 sshConfigs entry, got %d", len(doc.SSHConfigs))
	}
	got := doc.SSHConfigs[0]
	if got != host.entry() {
		t.Fatalf("entry mismatch: got %+v want %+v", got, host.entry())
	}
}

func TestUpsertClaudeSSHConfigPreservesOtherKeysAndEntries(t *testing.T) {
	paths, home := newPaths(t)
	path := filepath.Join(home, ".claude", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// Pre-existing settings with an unrelated top-level key and a foreign
	// sshConfigs entry that carries a field Amika does not model.
	seed := `{
  "model": "opus",
  "sshConfigs": [
    {"id": "other", "name": "Other", "sshHost": "other@host", "sshPort": 2222}
  ]
}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	host := ClaudeSSHHost{ID: "amika-abc", Name: "Amika: sb", SSHHost: "amika-abc"}
	if _, err := UpsertClaudeSSHConfig(paths, host); err != nil {
		t.Fatalf("UpsertClaudeSSHConfig: %v", err)
	}

	doc := map[string]json.RawMessage{}
	readJSON(t, path, &doc)
	if _, ok := doc["model"]; !ok {
		t.Fatalf("unrelated top-level key 'model' was dropped")
	}
	var entries []map[string]any
	if err := json.Unmarshal(doc["sshConfigs"], &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries (foreign + amika), got %d", len(entries))
	}
	// The foreign entry keeps its unmodeled sshPort field.
	var foreignKept bool
	for _, e := range entries {
		if e["id"] == "other" && e["sshPort"] != nil {
			foreignKept = true
		}
	}
	if !foreignKept {
		t.Fatalf("foreign entry's sshPort field was dropped: %+v", entries)
	}
}

func TestUpsertClaudeSSHConfigIdempotent(t *testing.T) {
	paths, _ := newPaths(t)
	host := ClaudeSSHHost{ID: "amika-abc", Name: "Amika: sb", SSHHost: "amika-abc"}

	if _, err := UpsertClaudeSSHConfig(paths, host); err != nil {
		t.Fatal(err)
	}
	changed, err := UpsertClaudeSSHConfig(paths, host)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatalf("expected changed=false on a no-op re-run")
	}
}

func TestUpsertClaudeSSHConfigUpdatesExisting(t *testing.T) {
	paths, home := newPaths(t)
	host := ClaudeSSHHost{ID: "amika-abc", Name: "Amika: sb", SSHHost: "amika-abc", StartDirectory: "/home/amika/workspace/a"}
	if _, err := UpsertClaudeSSHConfig(paths, host); err != nil {
		t.Fatal(err)
	}

	host.StartDirectory = "/home/amika/workspace/b"
	changed, err := UpsertClaudeSSHConfig(paths, host)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatalf("expected changed=true when start directory changes")
	}
	var doc struct {
		SSHConfigs []claudeSSHConfigEntry `json:"sshConfigs"`
	}
	readJSON(t, filepath.Join(home, ".claude", "settings.json"), &doc)
	if len(doc.SSHConfigs) != 1 || doc.SSHConfigs[0].StartDirectory != "/home/amika/workspace/b" {
		t.Fatalf("expected single updated entry, got %+v", doc.SSHConfigs)
	}
}

func TestEnableCodexRemoteConnections(t *testing.T) {
	paths, home := newPaths(t)
	changed, err := EnableCodexRemoteConnections(paths)
	if err != nil {
		t.Fatalf("EnableCodexRemoteConnections: %v", err)
	}
	if !changed {
		t.Fatalf("expected changed=true when creating the file")
	}

	doc := map[string]any{}
	readTOML(t, filepath.Join(home, ".codex", "config.toml"), &doc)
	features, _ := doc["features"].(map[string]any)
	if enabled, _ := features["remote_connections"].(bool); !enabled {
		t.Fatalf("expected features.remote_connections=true, got %+v", doc)
	}

	// Second run is a no-op.
	changed, err = EnableCodexRemoteConnections(paths)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatalf("expected changed=false on a no-op re-run")
	}
}

func TestEnableCodexRemoteConnectionsPreservesOtherKeys(t *testing.T) {
	paths, home := newPaths(t)
	path := filepath.Join(home, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	seed := "model = \"gpt-5\"\n\n[features]\nother_flag = true\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := EnableCodexRemoteConnections(paths); err != nil {
		t.Fatalf("EnableCodexRemoteConnections: %v", err)
	}

	doc := map[string]any{}
	readTOML(t, path, &doc)
	if doc["model"] != "gpt-5" {
		t.Fatalf("unrelated key 'model' was dropped: %+v", doc)
	}
	features, _ := doc["features"].(map[string]any)
	if enabled, _ := features["remote_connections"].(bool); !enabled {
		t.Fatalf("remote_connections not enabled: %+v", doc)
	}
	if kept, _ := features["other_flag"].(bool); !kept {
		t.Fatalf("existing features.other_flag was dropped: %+v", doc)
	}
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
}

func readTOML(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := toml.Unmarshal(data, v); err != nil {
		t.Fatalf("unmarshal %s: %v", path, err)
	}
}
