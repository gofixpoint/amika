package ssh

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/filelock"
)

const sessionLockTimeout = 10 * time.Second

// WithKeyRotationLock serializes the local-key, upload, and session-config
// steps that must finish as one operation for the remote and local identities
// to stay in sync.
func WithKeyRotationLock(ctx context.Context, paths basedir.Paths, action func() error) error {
	return withStateFileLock(ctx, paths, ".key-rotation.lock", action)
}

func withSessionLock(paths basedir.Paths, action func() error) error {
	ctx, cancel := context.WithTimeout(context.Background(), sessionLockTimeout)
	defer cancel()
	return withStateFileLock(ctx, paths, ".session.lock", action)
}

func withAgentLock(socketPath string, action func() error) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create SSH agent directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionLockTimeout)
	defer cancel()
	lock, err := filelock.Acquire(ctx, socketPath+".lock")
	if err != nil {
		return fmt.Errorf("lock dedicated Amika ssh-agent: %w", err)
	}
	defer lock.Close()
	return action()
}

func withStateFileLock(ctx context.Context, paths basedir.Paths, suffix string, action func() error) error {
	statePath, err := paths.SSHHostsStateFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		return fmt.Errorf("create SSH state directory: %w", err)
	}
	lock, err := filelock.Acquire(ctx, statePath+suffix)
	if err != nil {
		return fmt.Errorf("lock SSH session state: %w", err)
	}
	defer lock.Close()
	return action()
}
