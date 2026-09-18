package ssh

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestWithKeyRotationLockSerializesWholeActions(t *testing.T) {
	paths := testPaths(t)
	start := make(chan struct{})
	errors := make(chan error, 2)
	var mu sync.Mutex
	active := 0
	maxActive := 0
	for range 2 {
		go func() {
			<-start
			errors <- WithKeyRotationLock(context.Background(), paths, func() error {
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
