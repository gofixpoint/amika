package sshresume

import "time"

// Clock is the time source for every timer of a session, so tests can drive
// the timers without waiting.
type Clock interface {
	Now() time.Time
	// AfterFunc runs f in its own goroutine after d. It never runs f before
	// it returns.
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a pending AfterFunc call.
type Timer interface {
	// Stop cancels the call, and reports whether it did so before the call
	// started.
	Stop() bool
}

// SystemClock is the real clock.
type SystemClock struct{}

// Now returns the current time.
func (SystemClock) Now() time.Time { return time.Now() }

// AfterFunc wraps time.AfterFunc.
func (SystemClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }
