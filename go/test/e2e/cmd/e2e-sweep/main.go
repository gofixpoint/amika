// Command e2e-sweep reclaims remote resources left behind by E2E runs that
// were killed before their own cleanup could run.
//
// A run normally deletes everything it creates, even when a case fails or the
// run is interrupted. Only a process that dies outright (SIGKILL, a crashed
// machine) skips that, leaving resources recorded in its ledger but never
// deleted. This command replays those ledgers.
//
// It is deliberately not automatic. An unreclaimed ledger looks exactly like
// one belonging to a run still in flight, so sweeping is something a person
// asks for, having seen what it plans to delete:
//
//	make sweep-e2e SWEEP_ARGS=-dry-run
//	make sweep-e2e
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gofixpoint/amika/go/test/e2e/runner"
)

func main() {
	binPath := flag.String("bin", "dist/amika", "path to the amika binary that runs the recorded cleanup commands")
	runsRoot := flag.String("runs", "go/test/e2e/.runs", "directory holding E2E run directories")
	dryRun := flag.Bool("dry-run", false, "list what would be deleted without deleting anything")
	minAge := flag.Duration("min-age", 0, "only reclaim runs older than this (0 reclaims any run whose process is gone)")
	flag.Parse()

	if err := run(*binPath, *runsRoot, *dryRun, *minAge); err != nil {
		fmt.Fprintf(os.Stderr, "e2e-sweep: %v\n", err)
		os.Exit(1)
	}
}

func run(binPath, runsRoot string, dryRun bool, minAge time.Duration) error {
	stale, err := runner.FindStaleRuns(runsRoot, minAge)
	if err != nil {
		return err
	}
	if len(stale) == 0 {
		fmt.Printf("nothing to reclaim under %s\n", runsRoot)
		return nil
	}

	if dryRun {
		reportPlan(stale)
		return nil
	}
	return sweepAll(binPath, stale)
}

// reportPlan prints what a real sweep would delete, so the destructive step is
// only ever taken with sight of its targets.
func reportPlan(stale []runner.StaleRun) {
	fmt.Printf("would reclaim %d resource(s) from %d unreclaimed case(s):\n", countEntries(stale), len(stale))
	for _, run := range stale {
		fmt.Printf("\n  %s\n", run.CaseDir)
		for _, entry := range run.Entries {
			fmt.Printf("    %s %q -> amika %s\n", entry.Type, entry.Name, strings.Join(entry.CleanupArgv, " "))
		}
	}
	fmt.Print("\nre-run without -dry-run to delete these\n")
}

// sweepAll reclaims every stale run, reporting failures without stopping: one
// resource that refuses to delete must not strand the others.
func sweepAll(binPath string, stale []runner.StaleRun) error {
	fmt.Printf("reclaiming %d resource(s) from %d unreclaimed case(s)\n", countEntries(stale), len(stale))

	failed := 0
	for _, staleRun := range stale {
		result := runner.SweepStaleRun(binPath, staleRun, nil)
		if result.Err != nil {
			failed++
			fmt.Fprintf(os.Stderr, "  %s: sweep did not complete: %v\n", result.CaseDir, result.Err)
		}
		for _, cleanup := range result.Results {
			if cleanup.Err == nil {
				fmt.Printf("  deleted %s %q\n", cleanup.Entry.Type, cleanup.Entry.Name)
				continue
			}
			failed++
			// This directory is now recorded as reclaimed and will not be
			// retried, so print what a human needs to finish by hand.
			fmt.Fprintf(os.Stderr, "  FAILED to delete %s %q: %v\n    retry with: amika %s\n    stderr: %s\n",
				cleanup.Entry.Type, cleanup.Entry.Name, cleanup.Err,
				strings.Join(cleanup.Entry.CleanupArgv, " "), strings.TrimSpace(cleanup.Stderr))
		}
	}

	if failed > 0 {
		return fmt.Errorf("%d resource(s) could not be deleted and need attention", failed)
	}
	return nil
}

func countEntries(stale []runner.StaleRun) int {
	n := 0
	for _, run := range stale {
		n += len(run.Entries)
	}
	return n
}
