// sandbox_setup_test.go verifies that the container lifecycle correctly
// configures the environment and working directory before running the
// user-provided setup.sh hook.
//
// Background:
// When a sandbox starts, the ENTRYPOINT runs three hooks in order:
//   1. pre-setup.sh  — root-owned initialization; writes the agent working
//      directory to /var/lib/amikad/agent-cwd.
//   2. setup.sh      — user-provided hook; should see AMIKA_AGENT_CWD in the
//      environment and should run with CWD set to that directory.
//   3. post-setup.sh — root-owned cleanup.
//
// The CWD is set by run-hook.sh, which reads the agent-cwd file written by
// pre-setup.sh and cd's into it before executing setup.sh. This test ensures
// that both the environment variable and the working directory are correctly
// propagated.
//
// These tests require preset Docker images (e.g. coder) and are gated behind
// AMIKA_RUN_EXPENSIVE_TESTS=1 and AMIKA_RUN_DOCKER_INTEGRATION=1.

package cli_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/test/testutil"
)

// TestSetupScript_CWDAndEnv verifies that when AMIKA_AGENT_CWD is set, the
// user-provided setup.sh runs with:
//   - CWD equal to AMIKA_AGENT_CWD
//   - AMIKA_AGENT_CWD available in the environment
//
// It uses amika materialize with --preset coder and a setup script that
// records pwd and the env var to files. The materialize --cmd then copies
// those files to the output directory where the test can read them.
func TestSetupScript_CWDAndEnv(t *testing.T) {
	testutil.RequireDockerIntegration(t)
	if os.Getenv("AMIKA_RUN_EXPENSIVE_TESTS") != "1" {
		t.Skip("set AMIKA_RUN_EXPENSIVE_TESTS=1 to run expensive Docker rebuild tests")
	}

	bin := testutil.BuildAmikaBinary(t)

	// Write a temporary setup.sh that captures the CWD and env var.
	setupScript := filepath.Join(t.TempDir(), "setup.sh")
	err := os.WriteFile(setupScript, []byte("#!/bin/bash\npwd > /tmp/setup-cwd.txt\necho \"$AMIKA_AGENT_CWD\" > /tmp/setup-env.txt\n"), 0755)
	if err != nil {
		t.Fatalf("failed to write setup script: %v", err)
	}

	destdir := t.TempDir()
	expectedCWD := "/home/amika/workspace"

	// Run materialize with a preset image so the full lifecycle
	// (pre-setup -> setup -> post-setup) executes via the ENTRYPOINT.
	// AMIKA_OPENCODE_WEB=0 disables the opencode web server which
	// would otherwise require OPENCODE_SERVER_PASSWORD.
	cmd := exec.Command(bin,
		"materialize",
		"--preset", "coder",
		"--setup-script", setupScript,
		"--env", "AMIKA_AGENT_CWD="+expectedCWD,
		"--env", "AMIKA_OPENCODE_WEB=0",
		"--cmd", "cp /tmp/setup-cwd.txt . && cp /tmp/setup-env.txt .",
		"--destdir", destdir,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("materialize failed: %v\n%s", err, string(out))
	}

	// Verify that setup.sh ran with the correct CWD.
	cwdData, err := os.ReadFile(filepath.Join(destdir, "setup-cwd.txt"))
	if err != nil {
		t.Fatalf("failed to read setup-cwd.txt: %v", err)
	}
	if got := strings.TrimSpace(string(cwdData)); got != expectedCWD {
		t.Errorf("setup.sh CWD = %q, want %q", got, expectedCWD)
	}

	// Verify that AMIKA_AGENT_CWD was available in the environment.
	envData, err := os.ReadFile(filepath.Join(destdir, "setup-env.txt"))
	if err != nil {
		t.Fatalf("failed to read setup-env.txt: %v", err)
	}
	if got := strings.TrimSpace(string(envData)); got != expectedCWD {
		t.Errorf("AMIKA_AGENT_CWD = %q, want %q", got, expectedCWD)
	}
}
