package cli_test

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/test/testutil"
)

// TestSandboxCreateSaveFailureCleansUpContainer forces the sandbox record
// write to fail (read-only state directory) and verifies the created Docker
// container is removed instead of orphaned under the requested name, which
// would otherwise break the retry with "docker name already exists".
//
// The create runs from a fresh temp working directory so no git repo is
// detected: the sandbox is bare, and the only state write on the create path
// is the final store.Save.
func TestSandboxCreateSaveFailureCleansUpContainer(t *testing.T) {
	testutil.RequireDockerIntegration(t)
	bin := testutil.BuildAmikaBinary(t)
	name := testutil.NewSandboxName("amika-savefail")

	stateDir := t.TempDir()
	if err := os.Chmod(stateDir, 0o500); err != nil {
		t.Fatalf("chmod state dir read-only: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(stateDir, 0o755) })

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", name).Run()
	})

	create := exec.Command(bin, "sandbox", "create", "--local", "--name", name, "--image", "ubuntu:latest", "--yes")
	create.Dir = t.TempDir()
	create.Env = append(os.Environ(), "AMIKA_STATE_DIRECTORY="+stateDir)
	out, err := create.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail with a read-only state dir, got success:\n%s", string(out))
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
