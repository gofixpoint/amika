package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofixpoint/amika/go/internal/filelock"
)

// storeLockTimeout bounds how long a store mutation waits for its advisory
// file lock. Mutations are short (read, rewrite a small JSONL file), so a
// wedged holder should fail the operation rather than hang the caller.
const storeLockTimeout = 10 * time.Second

// lockStore takes the advisory lock that serializes read-modify-write cycles
// on the store file at path. The lock file is path + ".lock", created next to
// the store file.
func lockStore(path string) (*filelock.Lock, error) {
	// The lock file lives next to the store file, which may not exist yet on
	// the very first Save.
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("failed to create storage directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), storeLockTimeout)
	defer cancel()
	lock, err := filelock.Acquire(ctx, path+".lock")
	if err != nil {
		return nil, fmt.Errorf("locking store file %s: %w", path, err)
	}
	return lock, nil
}

// writeJSONLAtomic atomically replaces the JSONL file at path with the
// marshaled lines: it writes a temp file in the same directory and renames it
// over path, so a crash mid-write leaves the previous file intact instead of
// truncating it to zero bytes. Lines must not carry trailing newlines.
func writeJSONLAtomic(path string, lines [][]byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create storage directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	for _, line := range lines {
		if _, err := tmp.Write(line); err != nil {
			tmp.Close()
			return fmt.Errorf("failed to write store file: %w", err)
		}
		if _, err := tmp.WriteString("\n"); err != nil {
			tmp.Close()
			return fmt.Errorf("failed to write newline: %w", err)
		}
	}
	// Match the permissions os.Create produced before the store switched to
	// atomic writes (0666 & umask, typically 0644).
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to set permissions on %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("failed to replace store file %s: %w", path, err)
	}
	return nil
}

// marshalJSONL marshals each entry as one JSON line.
func marshalJSONL[T any](items []T, label string) ([][]byte, error) {
	lines := make([][]byte, 0, len(items))
	for _, item := range items {
		data, err := json.Marshal(item)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal %s: %w", label, err)
		}
		lines = append(lines, data)
	}
	return lines, nil
}
