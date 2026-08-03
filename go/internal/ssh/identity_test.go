package ssh

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGenerateIdentityIsOwnerOnlyAndIdempotent(t *testing.T) {
	privatePath := filepath.Join(t.TempDir(), ".ssh", "amika_id_ed25519")
	first, err := GenerateIdentity(privatePath)
	if err != nil {
		t.Fatalf("GenerateIdentity: %v", err)
	}
	second, err := GenerateIdentity(privatePath)
	if err != nil {
		t.Fatalf("idempotent GenerateIdentity: %v", err)
	}
	if first != second {
		t.Fatal("idempotent generation changed public key")
	}
	info, err := os.Stat(privatePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private mode = %o, want 600", info.Mode().Perm())
	}
}
