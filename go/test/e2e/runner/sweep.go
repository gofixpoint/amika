package runner

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// SweepResult is the outcome of reclaiming one stale case directory.
type SweepResult struct {
	// CaseDir is the case directory that was swept.
	CaseDir string
	// Results holds one CleanupResult per replayed ledger entry, in the order
	// Cleanup ran them (reverse registration order).
	Results []CleanupResult
	// Err is set when the sweep itself could not complete, e.g. an unreadable
	// ledger. An individual cleanup command failing is not an Err; that is
	// recorded in the corresponding CleanupResult.
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

// SweepStaleRuns reclaims resources left behind by earlier runs that died
// before their own cleanup could run. Deferred cleanup does not survive a
// `go test` timeout panic, a SIGKILL, or a crashed machine, so the ledger each
// run flushes to disk as it creates resources is the only record left; this
// replays it.
//
// A case directory under runsRoot is stale when its ledger records at least
// one entry and no cleanup-results.json sits beside it, which is exactly the
// state a killed run leaves behind. currentRunID names the in-flight run's
// directory, which is never swept.
//
// Sweeping writes the results file even when some deletes failed, so a
// directory is swept at most once: a failure is reported to the caller for a
// human to act on rather than retried by every future run against a resource
// that may already be gone. Callers should surface Failed results prominently.
//
// env is the base environment for the replayed cleanup commands; nil uses the
// current process environment. Each entry's own recorded env (its state
// directory and API URL) layers on top, so a resource is deleted from the same
// deployment it was created in.
func SweepStaleRuns(binPath, runsRoot, currentRunID string, env []string) ([]SweepResult, error) {
	caseDirs, err := findStaleCaseDirs(runsRoot, currentRunID)
	if err != nil {
		return nil, err
	}
	results := make([]SweepResult, 0, len(caseDirs))
	for _, caseDir := range caseDirs {
		results = append(results, sweepCaseDir(binPath, caseDir, env))
	}
	return results, nil
}

// findStaleCaseDirs returns every case directory under runsRoot that a killed
// run left holding live resources, in run-then-case name order. A missing
// runsRoot is not an error: it just means nothing has ever run here.
func findStaleCaseDirs(runsRoot, currentRunID string) ([]string, error) {
	runDirs, err := os.ReadDir(runsRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runs root %s: %w", runsRoot, err)
	}

	var stale []string
	for _, runDir := range runDirs {
		if !runDir.IsDir() || runDir.Name() == currentRunID {
			continue
		}
		runPath := filepath.Join(runsRoot, runDir.Name())
		caseDirs, err := os.ReadDir(runPath)
		if err != nil {
			return nil, fmt.Errorf("read run directory %s: %w", runPath, err)
		}
		for _, caseDir := range caseDirs {
			if !caseDir.IsDir() {
				continue
			}
			casePath := filepath.Join(runPath, caseDir.Name())
			isStale, err := isStaleCaseDir(casePath)
			if err != nil {
				return nil, err
			}
			if isStale {
				stale = append(stale, casePath)
			}
		}
	}
	return stale, nil
}

// isStaleCaseDir reports whether caseDir holds a ledger with at least one
// entry and no cleanup results beside it: a case that created something and
// died before deleting it.
func isStaleCaseDir(caseDir string) (bool, error) {
	_, err := os.Stat(filepath.Join(caseDir, cleanupResultsFileName))
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("stat cleanup results in %s: %w", caseDir, err)
	}

	entries, err := LoadLedgerEntries(filepath.Join(caseDir, ledgerFileName))
	if errors.Is(err, os.ErrNotExist) {
		// A case directory with no ledger at all never got far enough to
		// create anything.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return len(entries) > 0, nil
}

// sweepCaseDir replays one stale case directory's ledger and records what
// happened beside it.
func sweepCaseDir(binPath, caseDir string, env []string) SweepResult {
	out := SweepResult{CaseDir: caseDir}

	entries, err := LoadLedgerEntries(filepath.Join(caseDir, ledgerFileName))
	if err != nil {
		out.Err = err
		return out
	}
	out.Results = Cleanup(binPath, entries, env)

	if err := WriteCleanupResults(caseDir, out.Results); err != nil {
		// The deletes already ran; failing to record them would make this
		// directory look stale forever and re-delete on every future run.
		out.Err = err
	}
	return out
}
