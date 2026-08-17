package runner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStepTimeoutKillsWedgedStep(t *testing.T) {
	r, err := New(Options{
		BinPath:     hangScript(t),
		RunDir:      t.TempDir(),
		StepTimeout: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	start := time.Now()
	err = r.RunCase(context.Background(), &Case{
		Name:  "wedged",
		Steps: []Step{{Name: "hang", Cmd: []string{"hang"}}},
	})
	if err == nil {
		t.Fatal("expected a wedged step to fail rather than hang")
	}
	if !strings.Contains(err.Error(), "timed out after 100ms") {
		t.Fatalf("expected the error to name the step timeout, got: %v", err)
	}
	// The point of the timeout is bounding the wait, so assert it actually
	// returned rather than running the stub's full sleep.
	if elapsed := time.Since(start); elapsed > 30*time.Second {
		t.Fatalf("expected the step to be killed promptly, took %s", elapsed)
	}
}

func TestRunDeadlineKillsStepAndKeepsLedgerForCleanup(t *testing.T) {
	r, err := New(Options{
		BinPath: hangScript(t),
		RunDir:  t.TempDir(),
		// Far longer than the deadline, so the deadline is what stops it.
		StepTimeout: time.Hour,
		// Long enough that the first step finishes on its merits even on a
		// loaded machine, so it is the hanging second step that runs out.
		Deadline: time.Now().Add(2 * time.Second),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	err = r.RunCase(context.Background(), &Case{
		Name: "runs out of time",
		Steps: []Step{
			{
				Name: "create something",
				Cmd:  []string{"ok"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "made-before-the-deadline",
					Cleanup: []string{"ok"},
				},
			},
			{Name: "hang", Cmd: []string{"hang"}},
		},
	})
	if err == nil {
		t.Fatal("expected the case to fail at the deadline")
	}
	if !strings.Contains(err.Error(), "run deadline") {
		t.Fatalf("expected the error to name the run deadline, got: %v", err)
	}

	// The whole point of stopping at the deadline instead of being killed by
	// `go test`: what the case created is still recorded, so the caller's
	// cleanup can delete it.
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "made-before-the-deadline" {
		t.Fatalf("expected the created resource to survive in the ledger for cleanup, got %+v", entries)
	}
}

func TestInterruptFailsCaseSoCleanupCanRun(t *testing.T) {
	r, err := New(Options{
		BinPath:     hangScript(t),
		RunDir:      t.TempDir(),
		StepTimeout: time.Hour,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	defer cancel()

	err = r.RunCase(ctx, &Case{
		Name:  "interrupted",
		Steps: []Step{{Name: "hang", Cmd: []string{"hang"}}},
	})
	if err == nil {
		t.Fatal("expected an interrupted case to fail")
	}
	// Reported as an interrupt, not as a timeout: only the latter would mean
	// a wedged command or a too-short budget.
	if !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("expected the error to report an interrupt, got: %v", err)
	}
}

func TestStepTimeoutDefaultsWhenUnset(t *testing.T) {
	r, err := New(Options{BinPath: "unused", RunDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if r.opts.StepTimeout != DefaultStepTimeout {
		t.Fatalf("expected the default step timeout, got %s", r.opts.StepTimeout)
	}
}

// hangScript returns a stub binary that sleeps when its first argument is
// "hang" and exits 0 otherwise, standing in for a command that has wedged.
//
// It `exec`s the sleep rather than spawning it, so killing the step kills the
// process holding the output pipes. A spawned grandchild would keep them open
// and the kill would take the full stepKillGrace to drain, which is correct
// behavior but makes for a slow test.
func hangScript(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("stub script requires a POSIX shell")
	}
	path := filepath.Join(t.TempDir(), "hang.sh")
	writeFile(t, path, "#!/bin/sh\nif [ \"$1\" = \"hang\" ]; then exec sleep 60; fi\nexit 0\n")
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatalf("chmod stub: %v", err)
	}
	return path
}
