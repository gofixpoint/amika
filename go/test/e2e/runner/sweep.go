package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// runMetaFileName identifies the process that owns a run directory, so a
// sweeper can tell a run that died from one that is still in flight.
const runMetaFileName = "run.json"

// RunMeta records which process owns a run directory.
type RunMeta struct {
	// PID is the process that is executing the run.
	PID int `json:"pid"`
	// StartedAt is when the run began.
	StartedAt time.Time `json:"started_at"`
}

// WriteRunMeta records the owning process in runRoot (the directory holding
// one run's case directories). Sweeping consults it to leave live runs alone,
// so a run that creates resources should write it before starting.
func WriteRunMeta(runRoot string, meta RunMeta) error {
	if err := os.MkdirAll(runRoot, 0o755); err != nil {
		return fmt.Errorf("create run directory %s: %w", runRoot, err)
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal run metadata: %w", err)
	}
	path := filepath.Join(runRoot, runMetaFileName)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write run metadata: %w", err)
	}
	return nil
}

// StaleRun is one case directory left behind by a run that died before
// deleting what it created.
type StaleRun struct {
	// CaseDir is the case directory holding the unreclaimed ledger.
	CaseDir string
	// Entries are the resources that ledger recorded, in registration order.
	Entries []Entry
}

// FindStaleRuns reports every case directory under runsRoot that a killed run
// left holding live resources, in run-then-case name order. It reads only;
// callers pass the results to SweepStaleRun to actually delete anything, which
// keeps a dry run honest.
//
// A case directory qualifies when its ledger records at least one entry and no
// cleanup-results.json sits beside it, which is the state a killed run leaves.
// That is also what an in-flight case looks like, so runs whose owning process
// is still alive are skipped: sweeping one would delete a live sandbox out
// from under a run that is still using it. A run older than minAge is
// considered stale regardless of age; pass 0 to disable the age filter.
//
// A missing runsRoot is not an error; it means nothing has run here.
func FindStaleRuns(runsRoot string, minAge time.Duration) ([]StaleRun, error) {
	runDirs, err := os.ReadDir(runsRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runs root %s: %w", runsRoot, err)
	}

	var stale []StaleRun
	for _, runDir := range runDirs {
		if !runDir.IsDir() {
			continue
		}
		runPath := filepath.Join(runsRoot, runDir.Name())
		skip, err := shouldSkipRun(runPath, minAge)
		if err != nil {
			return nil, err
		}
		if skip {
			continue
		}
		found, err := staleCaseDirsIn(runPath)
		if err != nil {
			return nil, err
		}
		stale = append(stale, found...)
	}
	return stale, nil
}

// shouldSkipRun reports whether a run directory must be left alone: its owning
// process is still running, or it is younger than minAge.
func shouldSkipRun(runPath string, minAge time.Duration) (bool, error) {
	meta, found, err := readRunMeta(runPath)
	if err != nil {
		return false, err
	}
	if found && processAlive(meta.PID) {
		return true, nil
	}
	if minAge <= 0 {
		return false, nil
	}

	started := meta.StartedAt
	if !found || started.IsZero() {
		// No metadata to date the run by (an older layout, or a run killed
		// before it could write any). Fall back to the directory itself.
		info, err := os.Stat(runPath)
		if err != nil {
			return false, fmt.Errorf("stat run directory %s: %w", runPath, err)
		}
		started = info.ModTime()
	}
	return time.Since(started) < minAge, nil
}

// staleCaseDirsIn returns the case directories under one run directory that
// still hold unreclaimed resources.
func staleCaseDirsIn(runPath string) ([]StaleRun, error) {
	caseDirs, err := os.ReadDir(runPath)
	if err != nil {
		return nil, fmt.Errorf("read run directory %s: %w", runPath, err)
	}

	var stale []StaleRun
	for _, caseDir := range caseDirs {
		if !caseDir.IsDir() {
			continue
		}
		casePath := filepath.Join(runPath, caseDir.Name())
		entries, err := unreclaimedEntries(casePath)
		if err != nil {
			return nil, err
		}
		if len(entries) > 0 {
			stale = append(stale, StaleRun{CaseDir: casePath, Entries: entries})
		}
	}
	return stale, nil
}

// unreclaimedEntries returns the ledger entries of a case directory that has
// no cleanup results beside it, and none if it has already been reclaimed.
func unreclaimedEntries(caseDir string) ([]Entry, error) {
	_, err := os.Stat(filepath.Join(caseDir, cleanupResultsFileName))
	if err == nil {
		return nil, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("stat cleanup results in %s: %w", caseDir, err)
	}

	entries, err := LoadLedgerEntries(filepath.Join(caseDir, ledgerFileName))
	if errors.Is(err, os.ErrNotExist) {
		// No ledger at all: the case never got far enough to create anything.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return entries, nil
}

// SweepResult is the outcome of reclaiming one stale case directory.
type SweepResult struct {
	// CaseDir is the case directory that was swept.
	CaseDir string
	// Results holds one CleanupResult per replayed ledger entry, in the order
	// Cleanup ran them (reverse registration order).
	Results []CleanupResult
	// Err is set when the sweep itself could not complete, e.g. its results
	// could not be recorded. An individual cleanup command failing is not an
	// Err; that is recorded in the corresponding CleanupResult.
	Err error
}

// Failed reports whether the sweep failed to complete or any replayed cleanup
// command failed, meaning a resource may still be alive.
func (r SweepResult) Failed() bool {
	if r.Err != nil {
		return true
	}
	for _, res := range r.Results {
		if res.Err != nil {
			return true
		}
	}
	return false
}

// SweepStaleRun replays one stale run's recorded cleanup commands and records
// what happened beside its ledger. Each entry carries the state directory and
// API URL it was created with, so a resource is deleted from the deployment
// that created it; env supplies the rest of the environment (nil uses this
// process's own, which is where credentials normally live).
//
// The results file is written even when a delete failed, so a directory is
// reclaimed at most once. That trades an automatic retry for not re-deleting a
// resource that may already be gone: callers should report a failed result so
// a human can finish the job.
func SweepStaleRun(binPath string, run StaleRun, env []string) SweepResult {
	out := SweepResult{CaseDir: run.CaseDir}
	out.Results = Cleanup(binPath, run.Entries, env)
	if err := WriteCleanupResults(run.CaseDir, out.Results); err != nil {
		out.Err = err
	}
	return out
}

// readRunMeta loads a run directory's ownership metadata. The boolean is false
// when the directory has none, which an older run layout or a run killed
// before it could write one both produce.
func readRunMeta(runPath string) (RunMeta, bool, error) {
	data, err := os.ReadFile(filepath.Join(runPath, runMetaFileName))
	if errors.Is(err, os.ErrNotExist) {
		return RunMeta{}, false, nil
	}
	if err != nil {
		return RunMeta{}, false, fmt.Errorf("read run metadata in %s: %w", runPath, err)
	}
	var meta RunMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return RunMeta{}, false, fmt.Errorf("parse run metadata in %s: %w", runPath, err)
	}
	return meta, true, nil
}

// processAlive reports whether pid is a running process. Signal 0 performs
// the existence and permission checks without delivering anything; EPERM means
// the process exists but belongs to another user, which still counts as alive.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return errors.Is(err, os.ErrPermission)
}
