package ssh

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/filelock"
)

const sessionLockTimeout = 10 * time.Second

// SessionTransaction holds the lock shared by every session-state reader and
// writer. Key rotation keeps it across local key selection, remote upload, and
// config persistence so a stale reader cannot restore the previous identity.
type SessionTransaction struct {
	paths  basedir.Paths
	active *atomic.Bool
}

// WithSessionTransaction runs action while no other process can resolve or
// update the managed SSH session.
func WithSessionTransaction(ctx context.Context, paths basedir.Paths, action func(SessionTransaction) error) error {
	return withStateFileLock(ctx, paths, ".session.lock", func() error {
		active := &atomic.Bool{}
		active.Store(true)
		defer active.Store(false)
		return action(SessionTransaction{paths: paths, active: active})
	})
}

// Configure reconciles the agent and persists session state while the
// transaction lock is held.
func (t SessionTransaction) Configure(session SessionConfig) error {
	if t.active == nil || !t.active.Load() {
		return fmt.Errorf("SSH session transaction is no longer active")
	}
	return configureSessionLocked(t.paths, session)
}

func withSessionLock(paths basedir.Paths, action func() error) error {
	ctx, cancel := context.WithTimeout(context.Background(), sessionLockTimeout)
	defer cancel()
	return WithSessionTransaction(ctx, paths, func(SessionTransaction) error {
		return action()
	})
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
