package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSweepStaleRunsReclaimsKilledRun(t *testing.T) {
	bin := stubScript(t)
	runsRoot := t.TempDir()
	caseDir := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-sandbox-lifecycle",
		Entry{Type: "sandbox", Name: "lime-natal", CleanupArgv: []string{"0", "", ""}})

	results, err := SweepStaleRuns(bin, runsRoot, "20260102T000000Z", nil)
	if err != nil {
		t.Fatalf("SweepStaleRuns: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 swept case directory, got %d: %+v", len(results), results)
	}
	if results[0].CaseDir != caseDir {
		t.Fatalf("expected sweep of %s, got %s", caseDir, results[0].CaseDir)
	}
	if results[0].Failed() {
		t.Fatalf("expected sweep to succeed: %+v", results[0])
	}
	if len(results[0].Results) != 1 || results[0].Results[0].Entry.Name != "lime-natal" {
		t.Fatalf("unexpected cleanup results: %+v", results[0].Results)
	}

	// The results file is what stops the next run sweeping this again.
	var persisted []CleanupResult
	data, err := os.ReadFile(filepath.Join(caseDir, cleanupResultsFileName))
	if err != nil {
		t.Fatalf("read persisted cleanup results: %v", err)
	}
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatalf("parse persisted cleanup results: %v", err)
	}
	if len(persisted) != 1 || persisted[0].Entry.Name != "lime-natal" {
		t.Fatalf("unexpected persisted results: %+v", persisted)
	}
}

func TestSweepStaleRunsSkipsAlreadyCleanedAndCurrentRun(t *testing.T) {
	bin := stubScript(t)
	runsRoot := t.TempDir()

	cleaned := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-cleaned",
		Entry{Type: "sandbox", Name: "already-gone", CleanupArgv: []string{"0", "", ""}})
	if err := WriteCleanupResults(cleaned, []CleanupResult{{Entry: Entry{Name: "already-gone"}}}); err != nil {
		t.Fatalf("WriteCleanupResults: %v", err)
	}

	const currentRunID = "20260103T000000Z"
	writeStaleCase(t, runsRoot, currentRunID, "api-in-flight",
		Entry{Type: "sandbox", Name: "live-resource", CleanupArgv: []string{"0", "", ""}})

	// A case that registered nothing before dying has nothing to reclaim.
	writeStaleCase(t, runsRoot, "20260102T000000Z", "api-empty-ledger")

	results, err := SweepStaleRuns(bin, runsRoot, currentRunID, nil)
	if err != nil {
		t.Fatalf("SweepStaleRuns: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected nothing to sweep, got %+v", results)
	}
}

func TestSweepStaleRunsMarksSweptEvenWhenCleanupFails(t *testing.T) {
	bin := stubScript(t)
	runsRoot := t.TempDir()
	caseDir := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-doomed",
		Entry{Type: "sandbox", Name: "stubborn", CleanupArgv: []string{"1", "", "boom"}})

	results, err := SweepStaleRuns(bin, runsRoot, "current", nil)
	if err != nil {
		t.Fatalf("SweepStaleRuns: %v", err)
	}
	if len(results) != 1 || !results[0].Failed() {
		t.Fatalf("expected a failed sweep result, got %+v", results)
	}
	if results[0].Err != nil {
		t.Fatalf("a failing cleanup command is not a sweep error, got %v", results[0].Err)
	}
	if got := results[0].Results[0].Stderr; got != "boom" {
		t.Fatalf("expected the failure's stderr to be reported, got %q", got)
	}

	// Marked swept despite the failure, so a resource that is already gone is
	// not re-deleted by every future run. The caller reports it instead.
	if _, err := os.Stat(filepath.Join(caseDir, cleanupResultsFileName)); err != nil {
		t.Fatalf("expected the failed sweep to still be recorded: %v", err)
	}
	second, err := SweepStaleRuns(bin, runsRoot, "current", nil)
	if err != nil {
		t.Fatalf("second SweepStaleRuns: %v", err)
	}
	if len(second) != 0 {
		t.Fatalf("expected the second sweep to skip the recorded directory, got %+v", second)
	}
}

func TestSweepStaleRunsWithNoRunsDirectory(t *testing.T) {
	bin := stubScript(t)

	results, err := SweepStaleRuns(bin, filepath.Join(t.TempDir(), "never-ran"), "current", nil)
	if err != nil {
		t.Fatalf("a missing runs root is not an error, got %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("expected no results, got %+v", results)
	}
}

// writeStaleCase creates runsRoot/runID/caseName holding a ledger with the
// given entries and no cleanup results: the state a killed run leaves behind.
func writeStaleCase(t *testing.T, runsRoot, runID, caseName string, entries ...Entry) string {
	t.Helper()
	caseDir := filepath.Join(runsRoot, runID, caseName)
	if err := os.MkdirAll(caseDir, 0o755); err != nil {
		t.Fatalf("create case dir: %v", err)
	}
	l, err := NewLedger(filepath.Join(caseDir, ledgerFileName))
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	for _, entry := range entries {
		if err := l.Append(entry); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	return caseDir
}
