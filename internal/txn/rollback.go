package txn

import "sync"

// Rollbacker allows callers to undo partial state or disarm cleanup once an
// operation has been successfully committed.
type Rollbacker interface {
	// Rollback undoes any partial state created during the operation.
	Rollback()
	// Disarm prevents Rollback from doing anything on subsequent calls.
	// Call after the operation has been successfully committed.
	Disarm()
}

// NewRollbacker returns a Rollbacker backed by fn.
func NewRollbacker(fn func()) Rollbacker {
	return &rollbackerFn{fn: fn}
}

type rollbackerFn struct {
	mu         sync.Mutex
	fn         func()
	disarmed   bool
	rolledBack bool
}

func (r *rollbackerFn) Rollback() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disarmed || r.rolledBack {
		return
	}
	r.rolledBack = true
	r.fn()
}

func (r *rollbackerFn) Disarm() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.disarmed = true
}
