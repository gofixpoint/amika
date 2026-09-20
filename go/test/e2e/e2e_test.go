// Package e2e_test is the Go test entry point for the black-box E2E case
// runner: it selects the amika executable, discovers cases/*.yaml, and runs
// each as a subtest via the runner package.
package e2e_test

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/test/e2e/runner"
	"github.com/gofixpoint/amika/go/test/testutil"
)

// runE2EEnv gates this test: it drives a real subprocess CLI and, per
// case, may reach out over the network, so it does not run under a plain
// `go test ./...`.
const runE2EEnv = "AMIKA_RUN_E2E"

// binaryPathEnv optionally names the absolute executable the suite should run
// instead of building a temporary amika binary. It may be a wrapper that
// restores deployment-specific environment before invoking the real binary,
// which is required when an SSH ProxyCommand crosses a shell environment
// boundary.
const binaryPathEnv = "AMIKA_BINARY_PATH"

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

var sandboxProvider = flag.String(
	"sandbox-provider",
	providerFromEnv(),
	"sandbox provider used by every remote E2E sandbox creation",
)

func providerFromEnv() string {
	if provider := strings.TrimSpace(os.Getenv("E2E_SANDBOX_PROVIDER")); provider != "" {
		return provider
	}
	return "daytona"
}

func validSandboxProvider(provider string) bool {
	return runner.SupportedSandboxProviders[provider]
}

// cleanupReserve is how much of the `go test` -timeout budget is held back
// for cleanup. Nothing recovers a run that hits that timeout: it panics the
// binary from its own goroutine, skipping every deferred cleanup and
// orphaning whatever the in-flight case created. So no step is allowed to
// run inside this window; it belongs to deleting what has been created.
// Cleanup is per-case, so this only has to cover one case's resources.
const cleanupReserve = 2 * time.Minute

// minCaseRunway is the minimum time that must remain, on top of
// cleanupReserve, for starting another case to be worth it. Without it a case
// could start with seconds to spare and fail on the deadline rather than on
// its own merits.
const minCaseRunway = 5 * time.Minute

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

func e2eBinary(t *testing.T) string {
	t.Helper()
	configured, err := configuredE2EBinaryPath(os.Getenv(binaryPathEnv))
	if err != nil {
		t.Fatalf("%s: %v", binaryPathEnv, err)
	}
	if configured != "" {
		t.Logf("using %s override %s", binaryPathEnv, configured)
		return configured
	}
	return testutil.BuildAmikaBinary(t)
}

func configuredE2EBinaryPath(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("must be an absolute path, got %q", raw)
	}
	path := filepath.Clean(raw)
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q is not a regular file", path)
	}
	if info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("%q is not executable", path)
	}
	return path, nil
}

func TestConfiguredE2EBinaryPath(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "amika-wrapper")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := configuredE2EBinaryPath(executable)
	if err != nil {
		t.Fatalf("configuredE2EBinaryPath: %v", err)
	}
	if got != executable {
		t.Fatalf("configured path = %q, want %q", got, executable)
	}

	if _, err := configuredE2EBinaryPath("relative/amika"); err == nil {
		t.Fatal("relative AMIKA_BINARY_PATH unexpectedly accepted")
	}

	nonExecutable := filepath.Join(t.TempDir(), "amika-wrapper")
	if err := os.WriteFile(nonExecutable, []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := configuredE2EBinaryPath(nonExecutable); err == nil {
		t.Fatal("non-executable AMIKA_BINARY_PATH unexpectedly accepted")
	}
}

// TestE2ECases discovers every case file under cases/, runs each as a
// subtest against either AMIKA_BINARY_PATH or a freshly built amika binary,
// and cleans up any resources the case registered — even if the case failed
// or panicked.
func TestE2ECases(t *testing.T) {
	if os.Getenv(runE2EEnv) != "1" {
		t.Skipf("set %s=1 to run black-box E2E CLI cases", runE2EEnv)
	}
	if !validSandboxProvider(*sandboxProvider) {
		t.Fatalf("invalid -sandbox-provider %q (want daytona, e2b, freestyle, or vercel)", *sandboxProvider)
	}

	bin := e2eBinary(t)
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
	runsRoot := filepath.Join(moduleRoot, "test", "e2e", ".runs", runID)

	// Claim this run directory, so a sweep looking for leftovers can tell
	// these in-flight cases from ones a dead run abandoned (see e2e-sweep).
	if err := runner.WriteRunMeta(runsRoot, runner.RunMeta{PID: os.Getpid(), StartedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("claim run directory: %v", err)
	}

	// An interrupt must fail the case in flight rather than kill the process,
	// so cleanup still runs for what that case created. Cancelling this
	// context kills the running step and takes the normal failure path.
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	interruptHandled := make(chan struct{})
	defer close(interruptHandled)
	go func() {
		select {
		case <-ctx.Done():
			// Restore default signal handling, so a second interrupt kills
			// the binary outright even if cleanup itself is wedged.
			stopSignals()
		case <-interruptHandled:
		}
	}()

	// The reserve exists to protect the deletion of real remote resources, so
	// it is only enforced for a run that can create them. Offline cases finish
	// in milliseconds and clean up nothing, and holding them to a multi-minute
	// runway would break a perfectly reasonable `go test -timeout 1m`.
	var stepDeadline time.Time
	if deadline, ok := t.Deadline(); ok && os.Getenv(runAPIEnv) == "1" {
		stepDeadline = deadline.Add(-cleanupReserve)
	}

	for i, caseFile := range files {
		caseFile := caseFile
		caseName := strings.TrimSuffix(filepath.Base(caseFile), ".yaml")

		if err := ctx.Err(); err != nil {
			t.Errorf("interrupted with %d case(s) unrun", len(files)-i)
			break
		}
		if !stepDeadline.IsZero() && time.Now().Add(minCaseRunway).After(stepDeadline) {
			t.Errorf("stopping with %d case(s) unrun: less than %s left before the -timeout deadline, "+
				"not enough to run another case and still clean up after it. Raise -timeout "+
				"(make test-e2e-api E2E_API_TIMEOUT=...)", len(files)-i, minCaseRunway+cleanupReserve)
			break
		}

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
				RunID:           runID,
				SandboxProvider: *sandboxProvider,
				// Offline cases (not api-*) must never reach the real API,
				// even on a host that exports AMIKA_API_KEY/AMIKA_API_URL
				// ambiently (this dev environment does). Scrub those from the
				// base env so an offline case that accidentally invokes a
				// remote code path fails at the auth gate instead of silently
				// hitting production. api-* cases keep the ambient env (nil =
				// os.Environ()) so they can authenticate.
				Env: baseEnvFor(isAPICase),
				// No step may run into the window reserved for cleanup.
				Deadline: stepDeadline,
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

			if err := r.RunCase(ctx, c); err != nil {
				t.Fatalf("%v", err)
			}
		})
	}
}
