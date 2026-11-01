package runner

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// ledgerFileName is the per-case record of created resources, flushed
	// after every registration so a crash still leaves it on disk.
	ledgerFileName = "ledger.json"
	// cleanupResultsFileName is the per-case record of what cleanup deleted.
	// Its presence beside a ledger also marks that case directory as already
	// reclaimed, which is how SweepStaleRuns tells a finished run from a
	// killed one.
	cleanupResultsFileName = "cleanup-results.json"
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
	// VerifyGone, when set, is how cleanup confirms the resource is gone.
	// See the VerifyGone type.
	VerifyGone *VerifyGone `json:"verify_gone,omitempty"`
	// VerifyGoneError is set when the case asked for a verify_gone check but
	// it could not be built (a template that did not resolve). The resource
	// is still registered so it is deleted, but its cleanup cannot be
	// verified and is recorded as a failure.
	VerifyGoneError string `json:"verify_gone_error,omitempty"`
	// Env holds the environment overrides to apply when cleaning up this
	// resource: the creating step's own env overrides (persisted verbatim)
	// plus the resolved values of the cleanup target variables
	// (AMIKA_STATE_DIRECTORY and AMIKA_API_URL), whether those came from the
	// step, the injected state directory, or the run's base Options.Env.
	// Cleanup applies them on top of its base environment so the resource is
	// deleted against the same state and API it was created in, even when a
	// standalone reaper replays the ledger with no base environment of its own
	// (see CleanupFromLedgerFile). From the run's base Options.Env only those
	// two target variables are recorded, so ambient base-env credentials are
	// not written to disk; standalone recovery must run where those are already
	// set. A credential placed directly in a step's own env block IS persisted
	// verbatim, so avoid putting long-lived secrets there.
	Env map[string]string `json:"env,omitempty"`
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

// Remove deletes the most recently registered resource matching resourceType
// and name, then flushes the updated ledger. It is used after a case verifies
// that an operation consumed a previously registered resource. If the flush
// fails, the in-memory ledger is restored so cleanup protection is retained.
func (l *Ledger) Remove(resourceType, name string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.entries) - 1; i >= 0; i-- {
		if l.entries[i].Type != resourceType || l.entries[i].Name != name {
			continue
		}
		original := l.entries
		updated := make([]Entry, 0, len(original)-1)
		updated = append(updated, original[:i]...)
		updated = append(updated, original[i+1:]...)
		l.entries = updated
		if err := l.flushLocked(); err != nil {
			l.entries = original
			return false, err
		}
		return true, nil
	}
	return false, nil
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

// How a cleanup's deletion was confirmed. Recorded on every CleanupResult.
const (
	// VerifiedGone: the entry's VerifyGone check confirmed the resource no
	// longer exists.
	VerifiedGone = "gone"
	// VerifiedUnsupported: the entry has no VerifyGone, so the delete
	// command's exit status is all there is.
	VerifiedUnsupported = "unsupported"
	// VerifiedStillPresent: the resource still existed when the poll gave
	// up. The result's Err is set.
	VerifiedStillPresent = "still_present"
	// VerifiedUnchecked: the delete command failed, or the verify command
	// failed in a way that is not "not found", so nothing is known. The
	// result's Err is set.
	VerifiedUnchecked = "unchecked"
)

// CleanupResult is the outcome of running one ledger entry's cleanup
// command and, when the entry has a VerifyGone, confirming the deletion.
type CleanupResult struct {
	Entry  Entry  `json:"entry"`
	Err    error  `json:"-"`
	Error  string `json:"error,omitempty"`
	Stdout string `json:"stdout,omitempty"`
	Stderr string `json:"stderr,omitempty"`
	// Verified is one of the Verified* constants.
	Verified string `json:"verified"`
	// DeleteError is set when the cleanup command failed but the resource was
	// verified gone anyway: a case deleted it explicitly, so this second
	// delete found nothing. Kept so the audit shows what happened.
	DeleteError string `json:"delete_error,omitempty"`
}

// VerifyPolicy is how long Cleanup keeps asking whether a deleted resource
// is still there. Deletion is asynchronous on every provider, so a resource
// can remain for a while after its delete command returns.
type VerifyPolicy struct {
	Timeout  time.Duration
	Interval time.Duration
}

// DefaultVerifyPolicy is what Cleanup uses.
var DefaultVerifyPolicy = VerifyPolicy{Timeout: 2 * time.Minute, Interval: 5 * time.Second}

// Cleanup runs every entry's CleanupArgv through binPath, in REVERSE
// registration order (last-created resources are deleted first, which
// matters when later resources depend on earlier ones), and confirms each
// deletion with DefaultVerifyPolicy. A failing cleanup command is recorded in
// the returned result but does not stop cleanup of the remaining entries.
//
// env is the environment each cleanup command runs with; pass the run's step
// environment (see Runner.CleanupEnv) so a resource created under the run's
// isolated AMIKA_STATE_DIRECTORY (and any credential/URL overrides) is
// deleted from that same state rather than the invoking user's default
// state. A nil env falls back to the current process environment.
func Cleanup(binPath string, entries []Entry, env []string) []CleanupResult {
	return CleanupVerified(binPath, entries, env, DefaultVerifyPolicy)
}

// CleanupVerified is Cleanup with an explicit verification policy.
func CleanupVerified(binPath string, entries []Entry, env []string, policy VerifyPolicy) []CleanupResult {
	results := make([]CleanupResult, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		cmdEnv := mergeEnv(env, entry.Env)
		stdout, stderr, err := runArgv(binPath, entry.CleanupArgv, cmdEnv)
		result := CleanupResult{
			Entry:    entry,
			Err:      err,
			Stdout:   stdout,
			Stderr:   stderr,
			Verified: VerifiedUnchecked,
		}
		if err == nil && entry.VerifyGoneError != "" {
			result.Err = fmt.Errorf("deleted, but its verify_gone check could not be built: %s", entry.VerifyGoneError)
		} else if err == nil {
			result.Verified, result.Err = verifyGone(binPath, entry, cmdEnv, policy)
		} else if entry.VerifyGone != nil {
			// A failed delete may only mean the resource is already gone,
			// for example deleted by an earlier step of the case. Ask once:
			// a positive "does not exist" makes this a success. Anything else
			// keeps the delete's own error. One check, not a poll: nothing is
			// being deleted now, so waiting would not change the answer.
			once := VerifyPolicy{Timeout: 0, Interval: policy.Interval}
			if verified, verifyErr := verifyGone(binPath, entry, cmdEnv, once); verifyErr == nil && verified == VerifiedGone {
				result.Verified = VerifiedGone
				result.DeleteError = fmt.Sprintf("%v: %s", err, strings.TrimSpace(stderr))
				result.Err = nil
			}
		}
		if result.Err != nil {
			result.Error = result.Err.Error()
		}
		results = append(results, result)
	}
	return results
}

// verifyGone polls the entry's VerifyGone check until it reports the
// resource gone, or the policy's timeout passes. Only a positive "does not
// exist" answer counts as gone; a check that cannot answer (the command
// failed for another reason, or printed something unexpected) is unchecked,
// never gone, so an API outage cannot make a leaked resource look deleted.
func verifyGone(binPath string, entry Entry, env []string, policy VerifyPolicy) (string, error) {
	check := entry.VerifyGone
	if check == nil {
		return VerifiedUnsupported, nil
	}
	deadline := time.Now().Add(policy.Timeout)
	for {
		exists, err := check.run(binPath, env, entry.Name)
		if err != nil {
			return VerifiedUnchecked, fmt.Errorf("verify deletion of %s %q: %w", entry.Type, entry.Name, err)
		}
		if !exists {
			return VerifiedGone, nil
		}
		if time.Now().After(deadline) {
			return VerifiedStillPresent, errors.New("still exists after delete")
		}
		time.Sleep(policy.Interval)
	}
}

// run performs the check once. It returns whether the resource still exists,
// or an error when the command's result answers neither way.
func (v *VerifyGone) run(binPath string, env []string, name string) (exists bool, err error) {
	stdout, stderr, runErr := runArgv(binPath, v.Cmd, env)
	if v.NotFound != "" {
		if runErr == nil {
			return true, nil
		}
		if strings.Contains(stderr, v.NotFound) {
			return false, nil
		}
		return false, fmt.Errorf("lookup failed without %q: %w: %s", v.NotFound, runErr, strings.TrimSpace(stderr))
	}
	if runErr != nil {
		return false, fmt.Errorf("listing failed: %w: %s", runErr, strings.TrimSpace(stderr))
	}
	var doc any
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		return false, fmt.Errorf("listing is not JSON: %w", err)
	}
	values, err := CollectJSONPath(v.AbsentFrom, doc)
	if err != nil {
		return false, fmt.Errorf("listing: %w", err)
	}
	for _, value := range values {
		if fmt.Sprint(value) == name {
			return true, nil
		}
	}
	return false, nil
}

func runArgv(binPath string, argv, env []string) (stdout, stderr string, err error) {
	var out, errOut bytes.Buffer
	cmd := exec.Command(binPath, argv...)
	cmd.Env = env
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err = cmd.Run()
	return out.String(), errOut.String(), err
}

// mergeEnv returns base with overrides applied on top, deduplicating keys so
// each name appears once (last write wins). It returns base unchanged when
// there are no overrides. When base is nil (meaning "inherit the process
// environment") and there are overrides, it starts from os.Environ() so the
// overrides layer onto the inherited environment rather than replacing it.
func mergeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return base
	}
	if base == nil {
		base = os.Environ()
	}
	values := make(map[string]string, len(base)+len(overrides))
	order := make([]string, 0, len(base)+len(overrides))
	set := func(key, val string) {
		if _, ok := values[key]; !ok {
			order = append(order, key)
		}
		values[key] = val
	}
	for _, kv := range base {
		if key, val, ok := strings.Cut(kv, "="); ok {
			set(key, val)
		}
	}
	for key, val := range overrides {
		set(key, val)
	}
	out := make([]string, 0, len(order))
	for _, key := range order {
		out = append(out, key+"="+values[key])
	}
	return out
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
	path := filepath.Join(dir, cleanupResultsFileName)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write cleanup results: %w", err)
	}
	return nil
}
