package ssh

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileHostKeyPinStoreRefusesChangedKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "amika_known_hosts")
	store := FileHostKeyPinStore{Path: path}
	first := testHostKey(t)
	second := testHostKey(t)
	alias := "team.sbx_1.localhost-3011.amika"
	if err := store.Pin(alias, first); err != nil {
		t.Fatalf("first Pin: %v", err)
	}
	if err := store.Pin(alias, first); err != nil {
		t.Fatalf("idempotent Pin: %v", err)
	}
	if err := store.Pin(alias, second); !errors.Is(err, ErrHostKeyMismatch) {
		t.Fatalf("changed Pin error = %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), second) || string(contents) != alias+" "+first+"\n" {
		t.Fatalf("known hosts changed after mismatch: %q", contents)
	}
}
