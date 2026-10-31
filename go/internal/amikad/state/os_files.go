package state

import (
	"context"
	"io/fs"
	"os"

	"github.com/gofixpoint/amika/go/internal/amikad/platform"
)

// OSFiles atomically replaces files on the host filesystem through the
// current OS's platform implementation, which fails closed where secure
// fd-relative writes are not implemented.
type OSFiles struct{}

// ReadFile reads a complete file.
func (OSFiles) ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }

// Lstat reads metadata without following the final symlink.
func (OSFiles) Lstat(path string) (fs.FileInfo, error) { return os.Lstat(path) }

// WriteFileAtomic writes and renames relative to a no-symlink directory file
// descriptor, preventing path-component swaps between validation and commit.
func (OSFiles) WriteFileAtomic(path string, data []byte, mode fs.FileMode) error {
	return platform.Current().WriteFileAtomic(path, data, mode, nil)
}

// WriteFileAtomicOwned assigns ownership through the temporary file descriptor
// before installing it, so no attacker-controlled pathname is chowned.
func (OSFiles) WriteFileAtomicOwned(
	path string,
	data []byte,
	mode fs.FileMode,
	ownership Ownership,
) error {
	return platform.Current().WriteFileAtomic(
		path, data, mode, &platform.Ownership{UID: ownership.UID, GID: ownership.GID},
	)
}

// WithLock serializes a complete manifest transaction across amikad processes.
func (OSFiles) WithLock(ctx context.Context, path string, operation func() error) error {
	return platform.Current().WithLock(ctx, path, operation)
}
