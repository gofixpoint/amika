// Package watcher monitors sandbox lifecycle events and emits notifications.
package watcher

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/gofixpoint/amika/internal/sandbox"
)

// EventType identifies the kind of sandbox lifecycle event.
type EventType string

const (
	// EventExpirationWarning is emitted when a sandbox approaches its TTL.
	EventExpirationWarning EventType = "expiration_warning"
	// EventExpired is emitted when a sandbox has passed its TTL.
	EventExpired EventType = "expired"
	// EventAgentCompleted is emitted when a sandbox container exits.
	EventAgentCompleted EventType = "agent_completed"
)

const defaultInterval = 30 * time.Second

// Event represents a sandbox lifecycle notification.
type Event struct {
	Type        EventType `json:"type"`
	SandboxName string    `json:"sandboxName"`
	ExitCode    int       `json:"exitCode,omitempty"`
	Message     string    `json:"message"`
	Timestamp   string    `json:"timestamp"`
}

// StateChecker abstracts Docker container state inspection for testing.
type StateChecker interface {
	GetState(name string) (string, error)
	GetExitCode(name string) (int, error)
}

// DockerStateChecker implements StateChecker using real Docker commands.
type DockerStateChecker struct{}

// GetState returns the container state via docker inspect.
func (DockerStateChecker) GetState(name string) (string, error) {
	return sandbox.GetDockerContainerState(name)
}

// GetExitCode returns the container exit code via docker inspect.
func (DockerStateChecker) GetExitCode(name string) (int, error) {
	return sandbox.GetDockerContainerExitCode(name)
}

// Clock abstracts time for testing.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now().UTC() }

// Handler is a callback invoked when a lifecycle event occurs.
type Handler func(Event)

// Options configures a Watcher.
type Options struct {
	Store        sandbox.Store
	StateChecker StateChecker
	Clock        Clock
	Interval     time.Duration
	Handlers     []Handler
}

// Watcher polls sandbox state and emits lifecycle events.
type Watcher struct {
	store        sandbox.Store
	stateChecker StateChecker
	clock        Clock
	interval     time.Duration
	handlers     []Handler

	mu       sync.Mutex
	notified map[string]EventType // tracks last event emitted per sandbox
}

// New creates a Watcher from the given options.
func New(opts Options) *Watcher {
	interval := opts.Interval
	if interval <= 0 {
		interval = defaultInterval
		if envVal := os.Getenv("AMIKA_WATCHER_INTERVAL"); envVal != "" {
			if parsed, err := time.ParseDuration(envVal); err == nil && parsed > 0 {
				interval = parsed
			}
		}
	}
	clock := opts.Clock
	if clock == nil {
		clock = realClock{}
	}
	checker := opts.StateChecker
	if checker == nil {
		checker = DockerStateChecker{}
	}
	return &Watcher{
		store:        opts.Store,
		stateChecker: checker,
		clock:        clock,
		interval:     interval,
		handlers:     opts.Handlers,
		notified:     make(map[string]EventType),
	}
}

// Run starts the watch loop and blocks until ctx is cancelled.
func (w *Watcher) Run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	// Run one check immediately on start.
	w.check()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.check()
		}
	}
}

func (w *Watcher) check() {
	sandboxes, err := w.store.List()
	if err != nil {
		return
	}

	now := w.clock.Now()

	// Build set of active sandbox names for cleanup.
	active := make(map[string]struct{}, len(sandboxes))
	for _, sb := range sandboxes {
		active[sb.Name] = struct{}{}
		w.checkExpiration(sb, now)
		w.checkAgentCompletion(sb)
	}

	// Prune notified entries for sandboxes that no longer exist.
	w.mu.Lock()
	for name := range w.notified {
		if _, ok := active[name]; !ok {
			delete(w.notified, name)
		}
	}
	w.mu.Unlock()
}

func (w *Watcher) checkExpiration(sb sandbox.Info, now time.Time) {
	if sb.ExpiresAt == "" {
		return
	}
	expiresAt, err := time.Parse(time.RFC3339, sb.ExpiresAt)
	if err != nil {
		return
	}

	w.mu.Lock()
	lastEvent := w.notified[sb.Name]
	w.mu.Unlock()

	if now.After(expiresAt) || now.Equal(expiresAt) {
		if lastEvent != EventExpired {
			w.emit(Event{
				Type:        EventExpired,
				SandboxName: sb.Name,
				Message:     fmt.Sprintf("Sandbox %q has expired", sb.Name),
				Timestamp:   now.Format(time.RFC3339),
			})
			w.mu.Lock()
			w.notified[sb.Name] = EventExpired
			w.mu.Unlock()
		}
		return
	}

	if sb.WarnAt != "" && lastEvent != EventExpirationWarning && lastEvent != EventExpired {
		warnAt, err := time.Parse(time.RFC3339, sb.WarnAt)
		if err != nil {
			return
		}
		if now.After(warnAt) || now.Equal(warnAt) {
			remaining := expiresAt.Sub(now).Truncate(time.Second)
			w.emit(Event{
				Type:        EventExpirationWarning,
				SandboxName: sb.Name,
				Message:     fmt.Sprintf("Sandbox %q expires in %s", sb.Name, remaining),
				Timestamp:   now.Format(time.RFC3339),
			})
			w.mu.Lock()
			w.notified[sb.Name] = EventExpirationWarning
			w.mu.Unlock()
		}
	}
}

func (w *Watcher) checkAgentCompletion(sb sandbox.Info) {
	w.mu.Lock()
	lastEvent := w.notified[sb.Name]
	w.mu.Unlock()

	if lastEvent == EventAgentCompleted || lastEvent == EventExpired {
		return
	}

	state, err := w.stateChecker.GetState(sb.Name)
	if err != nil {
		return
	}
	if state != "exited" {
		return
	}

	exitCode, err := w.stateChecker.GetExitCode(sb.Name)
	if err != nil {
		exitCode = -1
	}

	now := w.clock.Now()
	w.emit(Event{
		Type:        EventAgentCompleted,
		SandboxName: sb.Name,
		ExitCode:    exitCode,
		Message:     fmt.Sprintf("Sandbox %q agent finished (exit code: %d)", sb.Name, exitCode),
		Timestamp:   now.Format(time.RFC3339),
	})
	w.mu.Lock()
	w.notified[sb.Name] = EventAgentCompleted
	w.mu.Unlock()
}

func (w *Watcher) emit(event Event) {
	for _, h := range w.handlers {
		h(event)
	}
}
