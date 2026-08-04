//go:build linux

package state

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// WriteFileAtomic writes and renames relative to a no-symlink directory file
// descriptor, preventing path-component swaps between validation and commit.
func (OSFiles) WriteFileAtomic(path string, data []byte, mode fs.FileMode) (returnErr error) {
	return writeFileAtomic(path, data, mode, nil)
}

// WriteFileAtomicOwned assigns ownership through the temporary file descriptor
// before installing it, so no attacker-controlled pathname is chowned.
func (OSFiles) WriteFileAtomicOwned(
	path string,
	data []byte,
	mode fs.FileMode,
	ownership Ownership,
) error {
	return writeFileAtomic(path, data, mode, &ownership)
}

func writeFileAtomic(
	path string,
	data []byte,
	mode fs.FileMode,
	ownership *Ownership,
) (returnErr error) {
	directoryFD, err := openDirectoryNoSymlinks(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer syscall.Close(directoryFD)

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temporaryName := ".amikad-atomic-" + hex.EncodeToString(random[:])
	temporaryFD, err := syscall.Openat(
		directoryFD,
		temporaryName,
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW,
		uint32(mode.Perm()),
	)
	if err != nil {
		return err
	}
	temporary := os.NewFile(uintptr(temporaryFD), temporaryName)
	defer func() {
		_ = syscall.Unlinkat(directoryFD, temporaryName)
	}()
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if ownership != nil {
		if err := temporary.Chown(ownership.UID, ownership.GID); err != nil {
			_ = temporary.Close()
			return err
		}
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := syscall.Renameat(directoryFD, temporaryName, directoryFD, filepath.Base(path)); err != nil {
		return err
	}
	return syscall.Fsync(directoryFD)
}

// WithLock serializes a complete manifest transaction across amikad processes.
func (OSFiles) WithLock(ctx context.Context, path string, operation func() error) error {
	lock, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return operation()
}

func openDirectoryNoSymlinks(path string) (int, error) {
	current, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/") {
		if component == "" {
			continue
		}
		next, err := syscall.Openat(current, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
		_ = syscall.Close(current)
		if err != nil {
			return -1, err
		}
		current = next
	}
	return current, nil
}
