package norelay

import (
	"encoding/base64"
	"io/fs"
	"testing"
	"time"
)

type tokenFiles struct {
	data  map[string][]byte
	mode  fs.FileMode
	reads int
}

func (f *tokenFiles) ReadFile(path string) ([]byte, error) {
	f.reads++
	data, ok := f.data[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}

func TestFileTokenVerifierRejectsWrongSizeBeforeReading(t *testing.T) {
	path := "/var/lib/amikad/connect-token"
	files := &tokenFiles{data: map[string][]byte{path: make([]byte, 1<<20)}, mode: 0o600}
	verifier := NewFileTokenVerifier(path, files)
	if verifier.Ready() {
		t.Fatal("oversized token file was ready")
	}
	if files.reads != 0 {
		t.Fatalf("oversized token file was read %d times", files.reads)
	}
}

func (f *tokenFiles) Lstat(path string) (fs.FileInfo, error) {
	data, ok := f.data[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return tokenFileInfo{size: int64(len(data)), mode: f.mode}, nil
}

type tokenFileInfo struct {
	size int64
	mode fs.FileMode
}

func (tokenFileInfo) Name() string        { return "connect-token" }
func (i tokenFileInfo) Size() int64       { return i.size }
func (i tokenFileInfo) Mode() fs.FileMode { return i.mode }
func (tokenFileInfo) ModTime() time.Time  { return time.Time{} }
func (tokenFileInfo) IsDir() bool         { return false }
func (tokenFileInfo) Sys() any            { return nil }

func TestFileTokenVerifierRejectsUnsafeTokensAndObservesRotation(t *testing.T) {
	path := "/var/lib/amikad/connect-token"
	first := base64.RawURLEncoding.EncodeToString(make([]byte, TokenBytes))
	secondBytes := make([]byte, TokenBytes)
	secondBytes[0] = 1
	second := base64.RawURLEncoding.EncodeToString(secondBytes)
	files := &tokenFiles{data: map[string][]byte{path: []byte(first)}, mode: 0o600}
	verifier := NewFileTokenVerifier(path, files)

	if !verifier.Verify(first) {
		t.Fatal("current token was rejected")
	}
	for _, candidate := range []string{"", first + "=", "not-base64", second} {
		if verifier.Verify(candidate) {
			t.Fatalf("unsafe candidate %q was accepted", candidate)
		}
	}

	files.data[path] = []byte(second)
	if verifier.Verify(first) || !verifier.Verify(second) {
		t.Fatal("verifier did not observe token rotation")
	}
	files.mode = 0o644
	if verifier.Verify(second) {
		t.Fatal("world-readable token file was accepted")
	}
	files.mode = fs.ModeSymlink | 0o777
	if verifier.Verify(second) {
		t.Fatal("symlink token file was accepted")
	}
}
