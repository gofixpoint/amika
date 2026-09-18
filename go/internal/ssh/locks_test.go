package ssh

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/config"
)

func TestWithSessionTransactionSerializesWholeActions(t *testing.T) {
	paths := testPaths(t)
	start := make(chan struct{})
	errors := make(chan error, 2)
	var mu sync.Mutex
	active := 0
	maxActive := 0
	for range 2 {
		go func() {
			<-start
			errors <- WithSessionTransaction(context.Background(), paths, func(SessionTransaction) error {
				mu.Lock()
				active++
				if active > maxActive {
					maxActive = active
				}
				mu.Unlock()
				time.Sleep(25 * time.Millisecond)
				mu.Lock()
				active--
				mu.Unlock()
				return nil
			})
		}()
	}
	close(start)
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	if maxActive != 1 {
		t.Fatalf("maximum concurrent key rotations = %d, want 1", maxActive)
	}
}

func TestSessionTransactionCannotConfigureAfterUnlock(t *testing.T) {
	paths := testPaths(t)
	var transaction SessionTransaction
	if err := WithSessionTransaction(context.Background(), paths, func(active SessionTransaction) error {
		transaction = active
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := transaction.Configure(SessionConfig{}); err == nil {
		t.Fatal("expired transaction configured session state")
	}
}

func TestSessionReaderCannotRestoreIdentityFromBeforeRotation(t *testing.T) {
	paths := testPaths(t)
	t.Setenv(config.EnvAPIURL, "http://localhost:3011")
	testBinary(t, "amika")
	dir := t.TempDir()
	oldSession := SessionConfig{
		IdentityFile:   filepath.Join(dir, "old_identity"),
		KnownHostsFile: filepath.Join(dir, "known_hosts"),
	}
	newSession := oldSession
	newSession.IdentityFile = filepath.Join(dir, "new_identity")
	if err := ConfigureSession(paths, oldSession); err != nil {
		t.Fatal(err)
	}

	locked := make(chan struct{})
	continueRotation := make(chan struct{})
	rotationDone := make(chan error, 1)
	go func() {
		rotationDone <- WithSessionTransaction(context.Background(), paths, func(transaction SessionTransaction) error {
			close(locked)
			<-continueRotation
			return transaction.Configure(newSession)
		})
	}()
	<-locked

	readerDone := make(chan struct {
		session SessionConfig
		err     error
	}, 1)
	go func() {
		session, err := EnsureSessionConfig(paths)
		readerDone <- struct {
			session SessionConfig
			err     error
		}{session: session, err: err}
	}()
	select {
	case <-readerDone:
		t.Fatal("session reader bypassed the key-rotation transaction")
	case <-time.After(25 * time.Millisecond):
	}
	close(continueRotation)
	if err := <-rotationDone; err != nil {
		t.Fatal(err)
	}
	result := <-readerDone
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.session.IdentityFile != newSession.IdentityFile {
		t.Fatalf("reader restored %q, want rotated identity %q", result.session.IdentityFile, newSession.IdentityFile)
	}
}
