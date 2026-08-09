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

func TestImportIdentityRequiresMatchingPrivateKey(t *testing.T) {
	directory := t.TempDir()
	firstPath := filepath.Join(directory, "first")
	firstPublic, err := GenerateIdentity(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	secondPath := filepath.Join(directory, "second")
	secondPublic, err := GenerateIdentity(secondPath)
	if err != nil {
		t.Fatal(err)
	}

	identityPath, imported, err := ImportIdentity(firstPath + ".pub")
	if err != nil {
		t.Fatalf("ImportIdentity: %v", err)
	}
	if identityPath != firstPath || imported != firstPublic {
		t.Fatalf("import = %q, %q", identityPath, imported)
	}
	if err := os.WriteFile(firstPath+".pub", []byte(secondPublic+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ImportIdentity(firstPath + ".pub"); err == nil {
		t.Fatal("ImportIdentity accepted a mismatched keypair")
	}
}
