//go:build !linux && !darwin

package platform

import (
	"context"
	"io/fs"
	"os/exec"
)

// current on any other OS fails closed: amikad has no fd-relative
// no-symlink write or interprocess lock here, so it refuses to handle
// credentials at all.
var current Platform = unsupportedPlatform{}

type unsupportedPlatform struct{}

// WriteFileAtomic fails closed.
func (unsupportedPlatform) WriteFileAtomic(string, []byte, fs.FileMode, *Ownership) error {
	return ErrUnsupported
}

// WithLock fails closed.
func (unsupportedPlatform) WithLock(context.Context, string, func() error) error {
	return ErrUnsupported
}

// DetachProcess fails closed.
func (unsupportedPlatform) DetachProcess(*exec.Cmd) error { return ErrUnsupported }

// SSHD reports no known sshd location.
func (unsupportedPlatform) SSHD() SSHD { return SSHD{} }

// CheckStrictModesPath fails closed.
func (unsupportedPlatform) CheckStrictModesPath(string, int) error { return ErrUnsupported }
