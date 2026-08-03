//go:build !linux

package state

import (
	"context"
	"errors"
	"io/fs"
)

var errSecureAtomicWritesUnsupported = errors.New("amikad sensitive writes require Linux")

// WriteFileAtomic fails closed where fd-relative no-symlink writes are not
// implemented.
func (OSFiles) WriteFileAtomic(string, []byte, fs.FileMode) error {
	return errSecureAtomicWritesUnsupported
}

// WithLock fails closed where interprocess manifest locking is not implemented.
func (OSFiles) WithLock(context.Context, string, func() error) error {
	return errSecureAtomicWritesUnsupported
}
