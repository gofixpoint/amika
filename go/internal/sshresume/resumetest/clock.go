// Package resumetest holds test doubles for sshresume: a clock tests advance
// by hand, and an in-memory transport pair that can cut at any byte or go
// silent. Only tests import it.
package resumetest

import (
	"sort"
	"sync"
	"time"

	"github.com/gofixpoint/amika/go/internal/sshresume"
)

// FakeClock runs timers only when Advance moves past them.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

// NewFakeClock starts at a fixed time.
func NewFakeClock() *FakeClock {
	return &FakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

// Now returns the clock's time.
func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc schedules f for Advance to run.
func (c *FakeClock) AfterFunc(d time.Duration, f func()) sshresume.Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &fakeTimer{clock: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, timer)
	return timer
}

// Advance moves the clock forward by d, and runs each timer that falls due in
// time order, on the caller's goroutine. A timer a callback schedules runs in
// the same call if it falls due.
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		if len(c.timers) == 0 || c.timers[0].at.After(target) {
			c.now = target
			c.mu.Unlock()
			return
		}
		next := c.timers[0]
		c.timers = c.timers[1:]
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

// Pending reports how many timers wait to run.
func (c *FakeClock) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.timers)
}

type fakeTimer struct {
	clock *FakeClock
	at    time.Time
	f     func()
}

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	for i, pending := range t.clock.timers {
		if pending == t {
			t.clock.timers = append(t.clock.timers[:i], t.clock.timers[i+1:]...)
			return true
		}
	}
	return false
}
