// Package e2e_test is the Go test entry point for the black-box E2E case
// runner: it builds the amika binary, discovers cases/*.yaml, and runs each
// as a subtest via the runner package.
package e2e_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/test/e2e/runner"
	"github.com/gofixpoint/amika/go/test/testutil"
)

// runE2EEnv gates this test: it drives a real subprocess CLI and, per
// case, may reach out over the network, so it does not run under a plain
// `go test ./...`.
const runE2EEnv = "AMIKA_RUN_E2E"

// openAPIURLEnv overrides the OpenAPI document that expect.schema names are
// validated against. It is a URL (or local path); when unset it defaults to
// defaultOpenAPIURL. The document is fetched at run time rather than checked
// into the repo, so schema assertions track the deployed API spec.
const openAPIURLEnv = "AMIKA_E2E_OPENAPI_URL"

// defaultOpenAPIURL is the OpenAPI document used when openAPIURLEnv is unset.
const defaultOpenAPIURL = "https://app.amika.dev/api/openapi.json"

// runAPIEnv additionally gates case files named "api-*.yaml": those talk to a
// real remote API and may create billable resources, so they need explicit
// opt-in beyond AMIKA_RUN_E2E. Offline cases (flag validation, rejections,
// --help) run with AMIKA_RUN_E2E alone and are safe anywhere.
const runAPIEnv = "AMIKA_RUN_E2E_API"

// apiCasePrefix marks a case file as reaching the real remote API.
const apiCasePrefix = "api-"

// credentialEnvVars are stripped from the base environment of offline cases
// so they cannot reach the real remote API on a host with ambient
// credentials. A step may still set them explicitly via its own env.
var credentialEnvVars = map[string]bool{
	"AMIKA_API_KEY": true,
	"AMIKA_API_URL": true,
}

// TestE2ECaseFilesLoad validates every case file without executing commands.
// It stays outside the E2E environment gates so ordinary CI catches malformed
// YAML and unknown fields even in real-API cases that are normally skipped.
func TestE2ECaseFilesLoad(t *testing.T) {
	moduleRoot := testutil.FindModuleRoot(t)
	caseFiles, err := runner.DiscoverCases(filepath.Join(moduleRoot, "test", "e2e", "cases"))
	if err != nil {
		t.Fatalf("discover cases: %v", err)
	}
	if len(caseFiles) == 0 {
		t.Fatal("no E2E case files found")
	}
	for _, caseFile := range caseFiles {
		caseFile := caseFile
		t.Run(filepath.Base(caseFile), func(t *testing.T) {
			if _, err := runner.LoadCase(caseFile); err != nil {
				t.Fatalf("load case: %v", err)
			}
		})
	}
}

// baseEnvFor returns the base environment for a case's steps. API cases get
// the process environment unchanged (nil defers to os.Environ() in the
// runner). Offline cases get os.Environ() with credential vars removed.
func baseEnvFor(isAPICase bool) []string {
	if isAPICase {
		return nil
	}
	full := os.Environ()
	scrubbed := make([]string, 0, len(full))
	for _, kv := range full {
		key, _, _ := strings.Cut(kv, "=")
		if credentialEnvVars[key] {
			continue
		}
		scrubbed = append(scrubbed, kv)
	}
	return scrubbed
}

// TestE2ECases discovers every case file under cases/, runs each as a
// subtest against a freshly built amika binary, and cleans up any
// resources the case registered — even if the case failed or panicked.
func TestE2ECases(t *testing.T) {
	if os.Getenv(runE2EEnv) != "1" {
		t.Skipf("set %s=1 to run black-box E2E CLI cases", runE2EEnv)
	}

	bin := testutil.BuildAmikaBinary(t)
	moduleRoot := testutil.FindModuleRoot(t)
	casesDir := filepath.Join(moduleRoot, "test", "e2e", "cases")
	schemaDoc := os.Getenv(openAPIURLEnv)
	if schemaDoc == "" {
		schemaDoc = defaultOpenAPIURL
	}

	files, err := runner.DiscoverCases(casesDir)
	if err != nil {
		t.Fatalf("discover cases in %s: %v", casesDir, err)
	}
	if len(files) == 0 {
		t.Fatalf("no case files found in %s", casesDir)
	}

	// The run ID is generated here, from the OS clock, rather than inside
	// the runner package: pure runner logic stays deterministic and
	// testable without a clock, while this Go test entry point owns the
	// one place that needs real time.
	runID := time.Now().UTC().Format("20060102T150405.000000000Z")
	runsDir := filepath.Join(moduleRoot, "test", "e2e", ".runs")
	runsRoot := filepath.Join(runsDir, runID)

	// A killed run leaves resources its ledger recorded but never deleted:
	// `go test`'s own timeout panic (the most common cause) skips every
	// deferred cleanup below. Reclaim those before starting, so a crash costs
	// one run rather than an orphaned remote resource per case.
	sweepStaleRuns(t, bin, runsDir, runID)

	for _, caseFile := range files {
		caseFile := caseFile
		caseName := strings.TrimSuffix(filepath.Base(caseFile), ".yaml")

		t.Run(caseName, func(t *testing.T) {
			isAPICase := strings.HasPrefix(caseName, apiCasePrefix)
			if isAPICase && os.Getenv(runAPIEnv) != "1" {
				t.Skipf("set %s=1 to run real-API case %q (may create billable resources)", runAPIEnv, caseName)
			}

			c, err := runner.LoadCase(caseFile)
			if err != nil {
				t.Fatalf("load case: %v", err)
			}

			runDir := filepath.Join(runsRoot, caseName)
			stateDir := filepath.Join(runDir, "state")
			if err := os.MkdirAll(stateDir, 0o755); err != nil {
				t.Fatalf("create state dir: %v", err)
			}

			r, err := runner.New(runner.Options{
				BinPath:   bin,
				RunDir:    runDir,
				StateDir:  stateDir,
				SchemaDoc: schemaDoc,
				// Exposed to cases as {{run_id}} so a case that names a
				// remote resource can make the name unique to this run.
				RunID: runID,
				// Offline cases (not api-*) must never reach the real API,
				// even on a host that exports AMIKA_API_KEY/AMIKA_API_URL
				// ambiently (this dev environment does). Scrub those from the
				// base env so an offline case that accidentally invokes a
				// remote code path fails at the auth gate instead of silently
				// hitting production. api-* cases keep the ambient env (nil =
				// os.Environ()) so they can authenticate.
				Env: baseEnvFor(isAPICase),
			})
			if err != nil {
				t.Fatalf("create runner: %v", err)
			}

			// Registered even before RunCase runs, so cleanup still fires
			// for any resource a case managed to register before a later
			// step failed or the test panicked.
			t.Cleanup(func() {
				results := runner.Cleanup(bin, r.Ledger().Entries(), r.CleanupEnv())
				if err := runner.WriteCleanupResults(runDir, results); err != nil {
					t.Logf("write cleanup results: %v", err)
				}
				for _, res := range results {
					if res.Err != nil {
						t.Logf("cleanup failed for %s %q: %v\nstdout:\n%s\nstderr:\n%s",
							res.Entry.Type, res.Entry.Name, res.Err, res.Stdout, res.Stderr)
					}
				}
			})

			if err := r.RunCase(c); err != nil {
				t.Fatalf("%v", err)
			}
		})
	}
}

// sweepStaleRuns reclaims resources orphaned by earlier runs that were killed
// before their cleanup could run. It is gated on runAPIEnv for the same reason
// the api-* cases are: every recorded cleanup argv deletes a real remote
// resource, so an offline-only run must not fire them.
//
// A sweep never fails the test. It reclaims what it can and reports the rest:
// the run that leaked is already over, and blocking a fresh run on a stale
// resource that may already be gone helps nobody.
func sweepStaleRuns(t *testing.T, bin, runsDir, currentRunID string) {
	t.Helper()
	if os.Getenv(runAPIEnv) != "1" {
		return
	}

	// A nil base env inherits this process's environment, which is where the
	// credentials live; each entry's recorded state directory and API URL
	// layer on top so the delete targets the deployment that created it.
	results, err := runner.SweepStaleRuns(bin, runsDir, currentRunID, nil)
	if err != nil {
		t.Logf("could not sweep orphaned resources from earlier runs: %v", err)
		return
	}

	for _, res := range results {
		if !res.Failed() {
			t.Logf("reclaimed %d orphaned resource(s) from %s", len(res.Results), res.CaseDir)
			continue
		}
		if res.Err != nil {
			t.Logf("sweep of %s did not complete: %v", res.CaseDir, res.Err)
		}
		for _, cleanup := range res.Results {
			if cleanup.Err == nil {
				continue
			}
			// This directory is now marked swept and will not be retried, so
			// print what a human needs to finish the job by hand.
			t.Logf("orphaned %s %q from %s still needs deleting (cleanup failed: %v)\n\tretry with: amika %s\n\tstderr:\n%s",
				cleanup.Entry.Type, cleanup.Entry.Name, res.CaseDir, cleanup.Err,
				strings.Join(cleanup.Entry.CleanupArgv, " "), cleanup.Stderr)
		}
	}
}
