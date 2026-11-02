//go:build linux || darwin

package platform

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteFileAtomicReplacesWithMode(t *testing.T) {
	path := filepath.Join(realTempDir(t), "secret")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Current().WriteFileAtomic(path, []byte("new"), 0o600, nil); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" || info.Mode().Perm() != 0o600 {
		t.Fatalf("file = %q mode %o, want new 600", got, info.Mode().Perm())
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("temporary file left behind: %v", entries)
	}
}

func TestWriteFileAtomicRefusesSymlinkedDirectory(t *testing.T) {
	target := realTempDir(t)
	link := filepath.Join(realTempDir(t), "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := Current().WriteFileAtomic(filepath.Join(link, "secret"), []byte("x"), 0o600, nil); err == nil {
		t.Fatal("write through a symlinked directory succeeded")
	}
	if _, err := os.Stat(filepath.Join(target, "secret")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("secret reached the symlink target: %v", err)
	}
}

func TestWithLockHonoursCancellation(t *testing.T) {
	path := filepath.Join(realTempDir(t), "lock")
	ctx, cancel := context.WithCancel(context.Background())
	err := Current().WithLock(context.Background(), path, func() error {
		cancel()
		return Current().WithLock(ctx, path, func() error {
			t.Fatal("second holder acquired a held lock")
			return nil
		})
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("nested WithLock error = %v, want context.Canceled", err)
	}
}

func TestCheckStrictModesPathRejectsWritableAncestor(t *testing.T) {
	parent := realTempDir(t)
	if err := os.Chmod(parent, 0o777); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(parent, "state")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := Current().CheckStrictModesPath(child, os.Getuid()); !errors.Is(err, ErrInsecureDirectory) {
		t.Fatalf("CheckStrictModesPath = %v, want ErrInsecureDirectory", err)
	}
}

func TestCheckStrictModesPathAcceptsHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	if err := Current().CheckStrictModesPath(home, os.Getuid()); err != nil {
		t.Skipf("home directory is not StrictModes-safe on this machine: %v", err)
	}
}

func TestFindSSHDReturnsAbsolutePath(t *testing.T) {
	path, err := FindSSHD(Current())
	if err != nil {
		t.Skipf("sshd not installed: %v", err)
	}
	if !filepath.IsAbs(path) {
		t.Fatalf("FindSSHD = %q, want an absolute path", path)
	}
}
