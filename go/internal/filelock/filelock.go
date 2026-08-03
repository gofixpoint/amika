// Package filelock provides cancellable cross-process advisory file locks.
package filelock

import (
	"context"
	"errors"
	"os"
	"time"
)

// Lock is one held exclusive advisory lock.
type Lock struct {
	file *os.File
}

// Acquire waits until path can be locked or ctx is cancelled.
func Acquire(ctx context.Context, path string) (*Lock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		locked, err := tryLock(file)
		if err != nil {
			_ = file.Close()
			return nil, err
		}
		if locked {
			return &Lock{file: file}, nil
		}
		select {
		case <-ctx.Done():
			_ = file.Close()
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// Close unlocks and closes the lock file.
func (l *Lock) Close() error {
	return errors.Join(unlock(l.file), l.file.Close())
}
