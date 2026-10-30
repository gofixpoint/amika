//go:build linux || darwin

package platform

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// unixPlatform implements Platform with fd-relative POSIX calls shared by
// Linux and macOS; only the OpenSSH details differ per OS.
type unixPlatform struct {
	sshd SSHD
}

// WriteFileAtomic writes and renames relative to a no-symlink directory file
// descriptor, preventing path-component swaps between validation and commit.
// Ownership is assigned through the temporary file descriptor before
// install, so no attacker-controlled pathname is ever chowned.
func (unixPlatform) WriteFileAtomic(
	path string,
	data []byte,
	mode fs.FileMode,
	ownership *Ownership,
) error {
	directoryFD, err := openDirectoryNoSymlinks(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer unix.Close(directoryFD)

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temporaryName := ".amikad-atomic-" + hex.EncodeToString(random[:])
	temporaryFD, err := unix.Openat(
		directoryFD,
		temporaryName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC,
		uint32(mode.Perm()),
	)
	if err != nil {
		return &fs.PathError{Op: "openat", Path: temporaryName, Err: err}
	}
	temporary := os.NewFile(uintptr(temporaryFD), temporaryName)
	defer func() {
		_ = unix.Unlinkat(directoryFD, temporaryName, 0)
	}()
	if err := fillTemporary(temporary, data, mode, ownership); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := unix.Renameat(directoryFD, temporaryName, directoryFD, filepath.Base(path)); err != nil {
		return &fs.PathError{Op: "renameat", Path: path, Err: err}
	}
	return unix.Fsync(directoryFD)
}

// WithLock serializes a complete transaction across amikad processes with a
// blocking-free flock poll that honours ctx.
func (unixPlatform) WithLock(ctx context.Context, path string, operation func() error) error {
	lock, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	for {
		err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	return operation()
}

// DetachProcess starts command in a new session so it survives the caller.
func (unixPlatform) DetachProcess(command *exec.Cmd) error {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return nil
}

// SSHD returns this OS's OpenSSH server details.
func (p unixPlatform) SSHD() SSHD { return p.sshd }

// CheckStrictModesPath mirrors OpenSSH's auth_secure_path walk from the
// resolved directory up to "/".
func (unixPlatform) CheckStrictModesPath(directory string, uid int) error {
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return err
	}
	for current := resolved; ; current = filepath.Dir(current) {
		var stat unix.Stat_t
		if err := unix.Stat(current, &stat); err != nil {
			return &fs.PathError{Op: "stat", Path: current, Err: err}
		}
		owner := int(stat.Uid)
		if (owner != 0 && owner != uid) || stat.Mode&0o022 != 0 {
			return fmt.Errorf("%w: %s (sshd StrictModes requires every directory to be owned by root or uid %d and not group- or world-writable)",
				ErrInsecureDirectory, current, uid)
		}
		if current == filepath.Dir(current) {
			return nil
		}
	}
}

func fillTemporary(temporary *os.File, data []byte, mode fs.FileMode, ownership *Ownership) error {
	if _, err := temporary.Write(data); err != nil {
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		return err
	}
	if ownership != nil {
		if err := temporary.Chown(ownership.UID, ownership.GID); err != nil {
			return err
		}
	}
	return temporary.Sync()
}

func openDirectoryNoSymlinks(path string) (int, error) {
	current, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/") {
		if component == "" {
			continue
		}
		next, err := unix.Openat(
			current,
			component,
			unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC,
			0,
		)
		_ = unix.Close(current)
		if err != nil {
			return -1, &fs.PathError{Op: "openat", Path: path, Err: err}
		}
		current = next
	}
	return current, nil
}
