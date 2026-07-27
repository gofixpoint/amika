package runner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Entry records one resource created during a run that must be cleaned up
// afterward, and the argv that cleans it up.
type Entry struct {
	// Type is a free-form resource kind, e.g. "sandbox" or "volume".
	Type string `json:"type"`
	// Name identifies the resource, e.g. a sandbox name.
	Name string `json:"name"`
	// CreatedByStep is the human step name that created the resource.
	CreatedByStep string `json:"created_by_step"`
	// CleanupArgv is the amika argv (not including the binary itself) that
	// deletes the resource.
	CleanupArgv []string `json:"cleanup_argv"`
	// CreatedAt is when the resource was registered.
	CreatedAt time.Time `json:"created_at"`
}

// Ledger is an incremental, disk-backed record of resources created during
// a run. Every Append flushes the full ledger to disk immediately, so a
// crash mid-run still leaves a file that can be used to clean up whatever
// was created before the crash.
type Ledger struct {
	path string

	mu      sync.Mutex
	entries []Entry
}

// NewLedger creates (or truncates) the ledger file at path and returns a
// Ledger ready to record entries.
func NewLedger(path string) (*Ledger, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create ledger directory: %w", err)
	}
	l := &Ledger{path: path, entries: []Entry{}}
	if err := l.flushLocked(); err != nil {
		return nil, err
	}
	return l, nil
}

// Append records entry and flushes the ledger to disk before returning.
func (l *Ledger) Append(entry Entry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.entries = append(l.entries, entry)
	return l.flushLocked()
}

// Entries returns a copy of the entries recorded so far, in registration
// order.
func (l *Ledger) Entries() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Entry, len(l.entries))
	copy(out, l.entries)
	return out
}

// Path returns the ledger's backing file path.
func (l *Ledger) Path() string {
	return l.path
}

func (l *Ledger) flushLocked() error {
	data, err := json.MarshalIndent(l.entries, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal ledger: %w", err)
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write ledger: %w", err)
	}
	if err := os.Rename(tmp, l.path); err != nil {
		return fmt.Errorf("finalize ledger: %w", err)
	}
	return nil
}

// LoadLedgerEntries reads a ledger.json file (e.g. from a prior, possibly
// crashed, run directory) and returns its recorded entries.
func LoadLedgerEntries(path string) ([]Entry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read ledger %s: %w", path, err)
	}
	var entries []Entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("parse ledger %s: %w", path, err)
	}
	return entries, nil
}

// CleanupResult is the outcome of running one ledger entry's cleanup
// command.
type CleanupResult struct {
	Entry  Entry  `json:"entry"`
	Err    error  `json:"-"`
	Error  string `json:"error,omitempty"`
	Stdout string `json:"stdout,omitempty"`
	Stderr string `json:"stderr,omitempty"`
}

// Cleanup runs every entry's CleanupArgv through binPath, in REVERSE
// registration order (last-created resources are deleted first, which
// matters when later resources depend on earlier ones). A failing cleanup
// command is recorded in the returned result but does not stop cleanup of
// the remaining entries.
//
// env is the environment each cleanup command runs with; pass the run's step
// environment (see Runner.CleanupEnv) so a resource created under the run's
// isolated AMIKA_STATE_DIRECTORY (and any credential/URL overrides) is
// deleted from that same state rather than the invoking user's default
// state. A nil env falls back to the current process environment.
func Cleanup(binPath string, entries []Entry, env []string) []CleanupResult {
	results := make([]CleanupResult, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		var stdout, stderr bytes.Buffer
		cmd := exec.Command(binPath, entry.CleanupArgv...)
		cmd.Env = env
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()

		result := CleanupResult{
			Entry:  entry,
			Err:    err,
			Stdout: stdout.String(),
			Stderr: stderr.String(),
		}
		if err != nil {
			result.Error = err.Error()
		}
		results = append(results, result)
	}
	return results
}

// CleanupFromLedgerFile loads a ledger.json file at ledgerPath and runs
// Cleanup against its entries with the given env (see Cleanup). This supports
// standalone reaping of a run that crashed before it could clean up after
// itself: point it at the crashed run's ledger.json and it replays every
// recorded cleanup. Pass nil env to use the current process environment.
func CleanupFromLedgerFile(binPath, ledgerPath string, env []string) ([]CleanupResult, error) {
	entries, err := LoadLedgerEntries(ledgerPath)
	if err != nil {
		return nil, err
	}
	return Cleanup(binPath, entries, env), nil
}

// WriteCleanupResults writes results as JSON to cleanup-results.json under
// dir, for later inspection.
func WriteCleanupResults(dir string, results []CleanupResult) error {
	data, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal cleanup results: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create run directory: %w", err)
	}
	path := filepath.Join(dir, "cleanup-results.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write cleanup results: %w", err)
	}
	return nil
}
