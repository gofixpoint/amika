package cli_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/test/testutil"
)

// TestSandboxCreateSaveFailureCleansUpContainer forces the sandbox record
// save to fail and verifies the created Docker container is removed instead of
// orphaned under the requested name, which would otherwise break the retry with
// "docker name already exists".
//
// The failure is injected by occupying the sandbox state file's path with a
// directory, so the record store can be neither read nor written. That confines
// the fault to the sandbox record: the rest of the state directory stays
// writable, so the volume, rwcopy and file-mount state that also lives there
// still works. Marking the entire state directory read-only instead makes the
// create fail earlier, while staging agent credentials, on any machine that has
// them, so the assertion below never sees the save path.
//
// The create runs from a fresh temp working directory so no git repo is
// detected: the sandbox is bare, and the record store is the only state the
// create has left to save.
func TestSandboxCreateSaveFailureCleansUpContainer(t *testing.T) {
	testutil.RequireDockerIntegration(t)
	bin := testutil.BuildAmikaBinary(t)
	name := testutil.NewSandboxName("amika-savefail")

	stateDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(stateDir, "sandboxes.jsonl"), 0o755); err != nil {
		t.Fatalf("occupy sandbox state file path with a directory: %v", err)
	}

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", name).Run()
	})

	create := exec.Command(bin, "sandbox", "create", "--local", "--name", name, "--image", "ubuntu:latest", "--yes")
	create.Dir = t.TempDir()
	create.Env = append(os.Environ(), "AMIKA_STATE_DIRECTORY="+stateDir)
	out, err := create.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail when the sandbox record cannot be saved, got success:\n%s", string(out))
	}
	if !strings.Contains(string(out), "failed to save state") {
		t.Fatalf("expected a save-state error, got:\n%s", string(out))
	}

	ps := exec.Command("docker", "ps", "-a", "--filter", "name="+name, "--format", "{{.Names}}")
	psOut, err := ps.CombinedOutput()
	if err != nil {
		t.Fatalf("docker ps failed: %v\n%s", err, string(psOut))
	}
	if got := strings.TrimSpace(string(psOut)); got != "" {
		t.Fatalf("container %q left behind after save failure: %s", name, got)
	}
}
