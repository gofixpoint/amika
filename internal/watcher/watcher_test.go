package watcher

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/gofixpoint/amika/internal/sandbox"
)

// fakeClock implements Clock with a controllable time.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock(t time.Time) *fakeClock {
	return &fakeClock{now: t}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}

// fakeStore implements sandbox.Store with in-memory data.
type fakeStore struct {
	items []sandbox.Info
}

func (s *fakeStore) Save(info sandbox.Info) error {
	for i, it := range s.items {
		if it.Name == info.Name {
			s.items[i] = info
			return nil
		}
	}
	s.items = append(s.items, info)
	return nil
}

func (s *fakeStore) Get(name string) (sandbox.Info, error) {
	for _, it := range s.items {
		if it.Name == name {
			return it, nil
		}
	}
	return sandbox.Info{}, nil
}

func (s *fakeStore) Remove(name string) error {
	var filtered []sandbox.Info
	for _, it := range s.items {
		if it.Name != name {
			filtered = append(filtered, it)
		}
	}
	s.items = filtered
	return nil
}

func (s *fakeStore) List() ([]sandbox.Info, error) {
	return s.items, nil
}

// fakeStateChecker implements StateChecker with configurable per-sandbox state.
type fakeStateChecker struct {
	mu       sync.Mutex
	states   map[string]string
	exitCode map[string]int
}

func newFakeStateChecker() *fakeStateChecker {
	return &fakeStateChecker{
		states:   make(map[string]string),
		exitCode: make(map[string]int),
	}
}

func (c *fakeStateChecker) SetState(name, state string, exitCode int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.states[name] = state
	c.exitCode[name] = exitCode
}

func (c *fakeStateChecker) GetState(name string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := c.states[name]; ok {
		return s, nil
	}
	return "running", nil
}

func (c *fakeStateChecker) GetExitCode(name string) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if code, ok := c.exitCode[name]; ok {
		return code, nil
	}
	return 0, nil
}

// eventCollector collects emitted events for assertions.
type eventCollector struct {
	mu     sync.Mutex
	events []Event
}

func (c *eventCollector) handler(e Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, e)
}

func (c *eventCollector) get() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]Event, len(c.events))
	copy(cp, c.events)
	return cp
}

func TestExpirationWarning(t *testing.T) {
	baseTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(baseTime)
	checker := newFakeStateChecker()
	checker.SetState("test-sb", "running", 0)

	store := &fakeStore{
		items: []sandbox.Info{{
			Name:      "test-sb",
			Provider:  "docker",
			CreatedAt: baseTime.Format(time.RFC3339),
			ExpiresAt: baseTime.Add(30 * time.Minute).Format(time.RFC3339),
			WarnAt:    baseTime.Add(20 * time.Minute).Format(time.RFC3339),
		}},
	}

	collector := &eventCollector{}
	w := New(Options{
		Store:        store,
		StateChecker: checker,
		Clock:        clock,
		Interval:     50 * time.Millisecond,
		Handlers:     []Handler{collector.handler},
	})

	ctx, cancel := context.WithCancel(context.Background())
	go w.Run(ctx)

	// Before warn time: no events.
	time.Sleep(100 * time.Millisecond)
	events := collector.get()
	if len(events) != 0 {
		t.Fatalf("expected 0 events before warn time, got %d", len(events))
	}

	// Advance to warn time.
	clock.Set(baseTime.Add(20 * time.Minute))
	time.Sleep(150 * time.Millisecond)

	events = collector.get()
	if len(events) != 1 {
		t.Fatalf("expected 1 warning event, got %d", len(events))
	}
	if events[0].Type != EventExpirationWarning {
		t.Fatalf("expected EventExpirationWarning, got %s", events[0].Type)
	}

	cancel()
}

func TestExpired(t *testing.T) {
	baseTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(baseTime.Add(31 * time.Minute)) // already past expiry
	checker := newFakeStateChecker()
	checker.SetState("test-sb", "running", 0)

	store := &fakeStore{
		items: []sandbox.Info{{
			Name:      "test-sb",
			Provider:  "docker",
			CreatedAt: baseTime.Format(time.RFC3339),
			ExpiresAt: baseTime.Add(30 * time.Minute).Format(time.RFC3339),
			WarnAt:    baseTime.Add(20 * time.Minute).Format(time.RFC3339),
		}},
	}

	collector := &eventCollector{}
	w := New(Options{
		Store:        store,
		StateChecker: checker,
		Clock:        clock,
		Interval:     50 * time.Millisecond,
		Handlers:     []Handler{collector.handler},
	})

	ctx, cancel := context.WithCancel(context.Background())
	go w.Run(ctx)
	time.Sleep(100 * time.Millisecond)
	cancel()

	events := collector.get()
	if len(events) != 1 {
		t.Fatalf("expected 1 expired event, got %d", len(events))
	}
	if events[0].Type != EventExpired {
		t.Fatalf("expected EventExpired, got %s", events[0].Type)
	}
}

func TestAgentCompleted(t *testing.T) {
	baseTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(baseTime)
	checker := newFakeStateChecker()
	checker.SetState("test-sb", "exited", 0)

	store := &fakeStore{
		items: []sandbox.Info{{
			Name:      "test-sb",
			Provider:  "docker",
			CreatedAt: baseTime.Format(time.RFC3339),
		}},
	}

	collector := &eventCollector{}
	w := New(Options{
		Store:        store,
		StateChecker: checker,
		Clock:        clock,
		Interval:     50 * time.Millisecond,
		Handlers:     []Handler{collector.handler},
	})

	ctx, cancel := context.WithCancel(context.Background())
	go w.Run(ctx)
	time.Sleep(100 * time.Millisecond)
	cancel()

	events := collector.get()
	if len(events) != 1 {
		t.Fatalf("expected 1 agent completed event, got %d", len(events))
	}
	if events[0].Type != EventAgentCompleted {
		t.Fatalf("expected EventAgentCompleted, got %s", events[0].Type)
	}
	if events[0].ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", events[0].ExitCode)
	}
}

func TestNoDuplicateNotifications(t *testing.T) {
	baseTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(baseTime.Add(31 * time.Minute))
	checker := newFakeStateChecker()
	checker.SetState("test-sb", "exited", 1)

	store := &fakeStore{
		items: []sandbox.Info{{
			Name:      "test-sb",
			Provider:  "docker",
			CreatedAt: baseTime.Format(time.RFC3339),
			ExpiresAt: baseTime.Add(30 * time.Minute).Format(time.RFC3339),
			WarnAt:    baseTime.Add(20 * time.Minute).Format(time.RFC3339),
		}},
	}

	collector := &eventCollector{}
	w := New(Options{
		Store:        store,
		StateChecker: checker,
		Clock:        clock,
		Interval:     50 * time.Millisecond,
		Handlers:     []Handler{collector.handler},
	})

	ctx, cancel := context.WithCancel(context.Background())
	go w.Run(ctx)
	// Let multiple poll cycles run.
	time.Sleep(300 * time.Millisecond)
	cancel()

	events := collector.get()
	// Should get exactly 1 expired event (expiry takes precedence over agent completed
	// since expired is checked first and blocks further events for that sandbox).
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 event (no duplicates), got %d: %+v", len(events), events)
	}
}

func TestNoExpirationNoEvents(t *testing.T) {
	baseTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clock := newFakeClock(baseTime)
	checker := newFakeStateChecker()
	checker.SetState("test-sb", "running", 0)

	store := &fakeStore{
		items: []sandbox.Info{{
			Name:      "test-sb",
			Provider:  "docker",
			CreatedAt: baseTime.Format(time.RFC3339),
			// No ExpiresAt — legacy sandbox
		}},
	}

	collector := &eventCollector{}
	w := New(Options{
		Store:        store,
		StateChecker: checker,
		Clock:        clock,
		Interval:     50 * time.Millisecond,
		Handlers:     []Handler{collector.handler},
	})

	ctx, cancel := context.WithCancel(context.Background())
	go w.Run(ctx)
	time.Sleep(150 * time.Millisecond)
	cancel()

	events := collector.get()
	if len(events) != 0 {
		t.Fatalf("expected 0 events for sandbox without TTL, got %d", len(events))
	}
}
