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

// ErrInvalidPath marks a sensitive target that is not an absolute clean path.
var ErrInvalidPath = errors.New("invalid sensitive file path")

// ErrSymlinkPath marks a sensitive target that resolves through a symlink.
var ErrSymlinkPath = errors.New("sensitive file path contains a symlink")

// SensitiveStore first registers an absolute path by atomically replacing the
// scrub manifest, then atomically replaces the sensitive file. A stale manifest
// entry is safe; an unregistered sensitive file is not.
type SensitiveStore interface {
	// WriteAndRegister uses ctx for cancellation, registers absolutePath in the
	// scrub manifest, reads the replacement contents from contents, and installs
	// the sensitive file with mode after the registration is durable.
	WriteAndRegister(ctx context.Context, absolutePath string, contents io.Reader, mode fs.FileMode) error
}

// FileSystem is the minimum filesystem boundary needed for ordered, atomic
// manifest and sensitive-file replacement.
type FileSystem interface {
	ReadFile(string) ([]byte, error)
	Lstat(string) (fs.FileInfo, error)
	WriteFileAtomic(string, []byte, fs.FileMode) error
}

// Store is the manifest-backed sensitive writer. Its implementation remains
// fail-closed until atomic file and manifest replacement land.
type Store struct {
	manifestPath string
	files        FileSystem
}

// NewStore creates a sensitive writer for an explicit manifest path.
func NewStore(manifestPath string, files FileSystem) *Store {
	return &Store{manifestPath: manifestPath, files: files}
}

// WriteAndRegister returns ErrNotImplemented without reading input or touching disk.
func (s *Store) WriteAndRegister(
	ctx context.Context,
	absolutePath string,
	contents io.Reader,
	mode fs.FileMode,
) error {
	_ = ctx
	_ = absolutePath
	_ = contents
	_ = mode
	_ = s.manifestPath
	_ = s.files
	return ErrNotImplemented
}

// UnimplementedStore rejects writes without reading input or touching disk.
type UnimplementedStore struct{}

// WriteAndRegister returns ErrNotImplemented without mutating state.
func (UnimplementedStore) WriteAndRegister(
	ctx context.Context,
	absolutePath string,
	contents io.Reader,
	mode fs.FileMode,
) error {
	_ = ctx
	_ = absolutePath
	_ = contents
	_ = mode
	return ErrNotImplemented
}
