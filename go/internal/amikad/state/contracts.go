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

// Store is the manifest-backed sensitive writer. Its implementation remains
// fail-closed until atomic file and manifest replacement land.
type Store struct {
	manifestPath string
}

// NewStore creates a sensitive writer for an explicit manifest path.
func NewStore(manifestPath string) *Store {
	return &Store{manifestPath: manifestPath}
}

// WriteAndRegister returns ErrNotImplemented without reading input or touching disk.
func (s *Store) WriteAndRegister(
	context.Context,
	string,
	io.Reader,
	fs.FileMode,
) error {
	_ = s.manifestPath
	return ErrNotImplemented
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
