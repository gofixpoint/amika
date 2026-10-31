// Package platform isolates amikad's OS-dependent operations: secure atomic
// writes and interprocess locking for sensitive state, detaching a background
// daemon, and locating and configuring the OpenSSH server.
//
// Build tags select one implementation per OS. Linux and macOS share the
// fd-relative unix implementation and differ only in OpenSSH details. Every
// other OS resolves to an implementation that fails closed, so amikad never
// writes a credential through a path it cannot protect from symlink swaps.
package platform

import (
	"context"
	"errors"
	"io/fs"
	"os/exec"
	"path/filepath"
)

// ErrUnsupported marks an operation this OS has no secure implementation for.
var ErrUnsupported = errors.New("amikad does not support this operating system")

// ErrInsecureDirectory marks a directory sshd's StrictModes would refuse to
// read authorized keys through.
var ErrInsecureDirectory = errors.New("directory is writable by other users")

// Ownership is the numeric owner applied to a file before it is installed.
type Ownership struct {
	UID int
	GID int
}

// Platform is the set of operations whose implementation depends on the OS.
type Platform interface {
	// WriteFileAtomic replaces path with data relative to a directory file
	// descriptor opened without following symlinks. A non-nil ownership is
	// applied to the temporary file before the rename installs it.
	WriteFileAtomic(path string, data []byte, mode fs.FileMode, ownership *Ownership) error
	// WithLock runs operation while holding an exclusive interprocess lock on
	// the file at path, creating it when absent.
	WithLock(ctx context.Context, path string, operation func() error) error
	// DetachProcess configures command to outlive the invoking process and
	// its controlling terminal.
	DetachProcess(command *exec.Cmd) error
	// SSHD returns the OpenSSH server details for this OS.
	SSHD() SSHD
	// CheckStrictModesPath fails when sshd's StrictModes would reject a file
	// in directory: directory and every ancestor must be owned by root or uid
	// and not group- or world-writable.
	CheckStrictModesPath(directory string, uid int) error
}

// SSHD describes how this OS ships OpenSSH's server.
type SSHD struct {
	// Candidates are absolute sshd paths tried, in order, after PATH. sshd
	// re-executes itself and refuses to start unless launched by absolute
	// path, and unprivileged PATHs often omit /usr/sbin.
	Candidates []string
	// PrivsepDirectory is the privilege-separation chroot a root sshd needs
	// and amikad must create, or "" when the OS already provides it. An
	// unprivileged sshd does not chroot and never needs it.
	PrivsepDirectory string
}

// Current returns the implementation for the OS amikad was built for.
func Current() Platform { return current }

// FindSSHD resolves the absolute path of the sshd binary: PATH first, then
// the OS's well-known locations.
func FindSSHD(platform Platform) (string, error) {
	if resolved, err := exec.LookPath("sshd"); err == nil && filepath.IsAbs(resolved) {
		return resolved, nil
	}
	for _, candidate := range platform.SSHD().Candidates {
		if resolved, err := exec.LookPath(candidate); err == nil {
			return resolved, nil
		}
	}
	return "", errors.New("sshd not found: install OpenSSH server")
}
