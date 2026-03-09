package txn_test

import (
	"sync"
	"testing"

	"github.com/gofixpoint/amika/internal/txn"
)

func TestRollbacker_Rollback(t *testing.T) {
	called := 0
	rb := txn.NewRollbacker(func() { called++ })
	rb.Rollback()
	if called != 1 {
		t.Fatalf("expected fn called once, got %d", called)
	}
}

func TestRollbacker_RollbackIdempotent(t *testing.T) {
	called := 0
	rb := txn.NewRollbacker(func() { called++ })
	rb.Rollback()
	rb.Rollback()
	if called != 1 {
		t.Fatalf("expected fn called once, got %d", called)
	}
}

func TestRollbacker_Disarm(t *testing.T) {
	called := 0
	rb := txn.NewRollbacker(func() { called++ })
	rb.Disarm()
	rb.Rollback()
	if called != 0 {
		t.Fatalf("expected fn not called after Disarm, got %d", called)
	}
}

func TestRollbacker_ConcurrentRollback(t *testing.T) {
	called := 0
	var mu sync.Mutex
	rb := txn.NewRollbacker(func() {
		mu.Lock()
		called++
		mu.Unlock()
	})

	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rb.Rollback()
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if called != 1 {
		t.Fatalf("expected fn called exactly once under concurrency, got %d", called)
	}
}

func TestRollbacker_ConcurrentDisarmAndRollback(t *testing.T) {
	called := 0
	var mu sync.Mutex
	rb := txn.NewRollbacker(func() {
		mu.Lock()
		called++
		mu.Unlock()
	})

	var wg sync.WaitGroup
	for range 10 {
		wg.Add(2)
		go func() { defer wg.Done(); rb.Disarm() }()
		go func() { defer wg.Done(); rb.Rollback() }()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if called > 1 {
		t.Fatalf("fn called more than once: %d", called)
	}
}
