package eventlog

import (
	"fmt"
	"os"
)

// lockFileName is the advisory lock file amikalog places in each source's
// sessions directory to serialize concurrent hook processes. It is ignored when
// resolving and uploading session files because it lacks the ".jsonl" suffix.
const lockFileName = ".lock"

// fileLock is a cross-process advisory lock held on an open file.
type fileLock struct {
	f *os.File
}

// acquireLock opens (creating if needed) path and takes an exclusive advisory
// lock on it, blocking until the lock is granted. Release it with release; the
// OS also releases it automatically if the process exits, so a crashed hook
// cannot wedge the lock.
func acquireLock(path string) (*fileLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("opening lock file %s: %w", path, err)
	}
	if err := flockExclusive(f.Fd()); err != nil {
		f.Close()
		return nil, fmt.Errorf("locking %s: %w", path, err)
	}
	return &fileLock{f: f}, nil
}

// release drops the lock by closing the underlying file.
func (l *fileLock) release() error {
	return l.f.Close()
}
