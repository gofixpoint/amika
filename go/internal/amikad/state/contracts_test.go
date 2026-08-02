package state

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreWritesSensitiveFileAndRegistersAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "injected-paths.json")
	tokenPath := filepath.Join(dir, "connect-token")
	store := NewStore(manifestPath)

	if err := store.WriteAndRegister(
		context.Background(),
		tokenPath,
		strings.NewReader("connect-token"),
		0o600,
	); err != nil {
		t.Fatalf("WriteAndRegister: %v", err)
	}

	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatalf("stat token: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("token mode = %o, want 600", got)
	}

	manifest, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var paths []string
	if err := json.Unmarshal(manifest, &paths); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if len(paths) != 1 || paths[0] != tokenPath {
		t.Fatalf("manifest paths = %#v, want [%q]", paths, tokenPath)
	}
}
