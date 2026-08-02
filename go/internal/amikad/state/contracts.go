// Package state owns amikad's sensitive files and scrub manifest.
package state

import (
	"context"
	"errors"
	"io"
	"io/fs"
)

// ErrNotImplemented marks the fail-closed state stub.
var ErrNotImplemented = errors.New("amikad state store is not implemented")

// SensitiveStore atomically writes sensitive data and registers its path in
// the injected-path scrub manifest as one operation.
type SensitiveStore interface {
	WriteAndRegister(context.Context, string, io.Reader, fs.FileMode) error
}

// UnimplementedStore rejects writes without reading input or touching disk.
type UnimplementedStore struct{}

// WriteAndRegister returns ErrNotImplemented without mutating state.
func (UnimplementedStore) WriteAndRegister(
	context.Context,
	string,
	io.Reader,
	fs.FileMode,
) error {
	return ErrNotImplemented
}
