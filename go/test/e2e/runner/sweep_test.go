package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFindStaleRunsReportsKilledRun(t *testing.T) {
	runsRoot := t.TempDir()
	caseDir := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-sandbox-lifecycle",
		Entry{Type: "sandbox", Name: "lime-natal", CleanupArgv: []string{"0", "", ""}})
	claimRun(t, runsRoot, "20260101T000000Z", deadPID(t), time.Now().Add(-time.Hour))

	stale, err := FindStaleRuns(runsRoot, 0)
	if err != nil {
		t.Fatalf("FindStaleRuns: %v", err)
	}
	if len(stale) != 1 {
		t.Fatalf("expected 1 stale case directory, got %d: %+v", len(stale), stale)
	}
	if stale[0].CaseDir != caseDir {
		t.Fatalf("expected %s, got %s", caseDir, stale[0].CaseDir)
	}
	if len(stale[0].Entries) != 1 || stale[0].Entries[0].Name != "lime-natal" {
		t.Fatalf("unexpected entries: %+v", stale[0].Entries)
	}
}

func TestFindStaleRunsLeavesLiveRunAlone(t *testing.T) {
	runsRoot := t.TempDir()
	writeStaleCase(t, runsRoot, "20260101T000000Z", "api-in-flight",
		Entry{Type: "sandbox", Name: "live-resource", CleanupArgv: []string{"0", "", ""}})
	// A run owned by a process that is still alive: mid-case, not abandoned.
	// Deleting its sandbox would break a run that is still using it.
	claimRun(t, runsRoot, "20260101T000000Z", os.Getpid(), time.Now())

	stale, err := FindStaleRuns(runsRoot, 0)
	if err != nil {
		t.Fatalf("FindStaleRuns: %v", err)
	}
	if len(stale) != 0 {
		t.Fatalf("expected a live run to be left alone, got %+v", stale)
	}
}

func TestFindStaleRunsSkipsReclaimedAndEmptyLedgers(t *testing.T) {
	runsRoot := t.TempDir()

	reclaimed := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-reclaimed",
		Entry{Type: "sandbox", Name: "already-gone", CleanupArgv: []string{"0", "", ""}})
	if err := WriteCleanupResults(reclaimed, []CleanupResult{{Entry: Entry{Name: "already-gone"}}}); err != nil {
		t.Fatalf("WriteCleanupResults: %v", err)
	}
	// A case that registered nothing before dying has nothing to reclaim.
	writeStaleCase(t, runsRoot, "20260102T000000Z", "api-empty-ledger")

	stale, err := FindStaleRuns(runsRoot, 0)
	if err != nil {
		t.Fatalf("FindStaleRuns: %v", err)
	}
	if len(stale) != 0 {
		t.Fatalf("expected nothing stale, got %+v", stale)
	}
}

func TestFindStaleRunsHonorsMinAge(t *testing.T) {
	runsRoot := t.TempDir()
	writeStaleCase(t, runsRoot, "20260101T000000Z", "api-recent",
		Entry{Type: "sandbox", Name: "recent", CleanupArgv: []string{"0", "", ""}})
	claimRun(t, runsRoot, "20260101T000000Z", deadPID(t), time.Now().Add(-5*time.Minute))

	stale, err := FindStaleRuns(runsRoot, time.Hour)
	if err != nil {
		t.Fatalf("FindStaleRuns: %v", err)
	}
	if len(stale) != 0 {
		t.Fatalf("expected a run younger than min-age to be skipped, got %+v", stale)
	}

	stale, err = FindStaleRuns(runsRoot, time.Minute)
	if err != nil {
		t.Fatalf("FindStaleRuns: %v", err)
	}
	if len(stale) != 1 {
		t.Fatalf("expected the run to be stale once older than min-age, got %+v", stale)
	}
}

func TestFindStaleRunsWithNoRunsDirectory(t *testing.T) {
	stale, err := FindStaleRuns(filepath.Join(t.TempDir(), "never-ran"), 0)
	if err != nil {
		t.Fatalf("a missing runs root is not an error, got %v", err)
	}
	if len(stale) != 0 {
		t.Fatalf("expected nothing stale, got %+v", stale)
	}
}

func TestSweepStaleRunReclaimsAndRecords(t *testing.T) {
	bin := stubScript(t)
	runsRoot := t.TempDir()
	caseDir := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-crashed",
		Entry{Type: "sandbox", Name: "lime-natal", CleanupArgv: []string{"0", "", ""}})

	result := SweepStaleRun(bin, StaleRun{
		CaseDir: caseDir,
		Entries: []Entry{{Type: "sandbox", Name: "lime-natal", CleanupArgv: []string{"0", "", ""}}},
	}, nil)
	if result.Failed() {
		t.Fatalf("expected the sweep to succeed: %+v", result)
	}

	// The results file is what stops a later sweep reclaiming this again.
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

	stale, err := FindStaleRuns(runsRoot, 0)
	if err != nil {
		t.Fatalf("FindStaleRuns: %v", err)
	}
	if len(stale) != 0 {
		t.Fatalf("expected the reclaimed case to no longer be stale, got %+v", stale)
	}
}

func TestSweepStaleRunRecordsEvenWhenCleanupFails(t *testing.T) {
	bin := stubScript(t)
	runsRoot := t.TempDir()
	entry := Entry{Type: "sandbox", Name: "stubborn", CleanupArgv: []string{"1", "", "boom"}}
	caseDir := writeStaleCase(t, runsRoot, "20260101T000000Z", "api-doomed", entry)

	result := SweepStaleRun(bin, StaleRun{CaseDir: caseDir, Entries: []Entry{entry}}, nil)
	if !result.Failed() {
		t.Fatalf("expected a failed sweep result, got %+v", result)
	}
	if result.Err != nil {
		t.Fatalf("a failing cleanup command is not a sweep error, got %v", result.Err)
	}
	if got := result.Results[0].Stderr; got != "boom" {
		t.Fatalf("expected the failure's stderr to be reported, got %q", got)
	}

	// Recorded despite the failure, so a resource that is already gone is not
	// re-deleted by every later sweep. The caller reports it instead.
	if _, err := os.Stat(filepath.Join(caseDir, cleanupResultsFileName)); err != nil {
		t.Fatalf("expected the failed sweep to still be recorded: %v", err)
	}
}

func TestWriteRunMetaRoundTrip(t *testing.T) {
	runRoot := filepath.Join(t.TempDir(), "20260101T000000Z")
	started := time.Now().UTC().Truncate(time.Second)
	if err := WriteRunMeta(runRoot, RunMeta{PID: 4242, StartedAt: started}); err != nil {
		t.Fatalf("WriteRunMeta: %v", err)
	}

	meta, found, err := readRunMeta(runRoot)
	if err != nil {
		t.Fatalf("readRunMeta: %v", err)
	}
	if !found {
		t.Fatal("expected the run metadata to be found")
	}
	if meta.PID != 4242 || !meta.StartedAt.Equal(started) {
		t.Fatalf("unexpected metadata: %+v", meta)
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

// claimRun writes the ownership metadata a run records for itself.
func claimRun(t *testing.T, runsRoot, runID string, pid int, startedAt time.Time) {
	t.Helper()
	if err := WriteRunMeta(filepath.Join(runsRoot, runID), RunMeta{PID: pid, StartedAt: startedAt}); err != nil {
		t.Fatalf("WriteRunMeta: %v", err)
	}
}

// deadPID returns the pid of a process that has already exited, standing in
// for the owner of a run that was killed.
func deadPID(t *testing.T) int {
	t.Helper()
	// A child that has been reaped: its pid is no longer signalable, which is
	// what processAlive checks.
	proc, err := os.StartProcess("/bin/sh", []string{"sh", "-c", "exit 0"}, &os.ProcAttr{})
	if err != nil {
		t.Skipf("cannot start a stub process: %v", err)
	}
	if _, err := proc.Wait(); err != nil {
		t.Fatalf("wait for stub process: %v", err)
	}
	return proc.Pid
}
