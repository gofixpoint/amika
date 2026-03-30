package cli_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/test/testutil"
)

func TestSandboxLifecycle(t *testing.T) {
	testutil.RequireDockerIntegration(t)
	bin := testutil.BuildAmikaBinary(t)
	name := testutil.NewSandboxName("amika-int")

	t.Cleanup(func() {
		_ = exec.Command(bin, "sandbox", "delete", "--local", "--force", name, "--keep-volumes").Run()
	})

	create := exec.Command(bin, "sandbox", "create", "--local", "--name", name, "--image", "ubuntu:latest", "--yes")
	createOut, err := create.CombinedOutput()
	if err != nil {
		t.Fatalf("sandbox create failed: %v\n%s", err, string(createOut))
	}

	list := exec.Command(bin, "sandbox", "list", "--local")
	listOut, err := list.CombinedOutput()
	if err != nil {
		t.Fatalf("sandbox list failed: %v\n%s", err, string(listOut))
	}
	if !strings.Contains(string(listOut), name) {
		t.Fatalf("expected sandbox list output to contain %q, got:\n%s", name, string(listOut))
	}

	deleteCmd := exec.Command(bin, "sandbox", "delete", "--local", "--force", name, "--keep-volumes")
	deleteOut, err := deleteCmd.CombinedOutput()
	if err != nil {
		t.Fatalf("sandbox delete failed: %v\n%s", err, string(deleteOut))
	}
}
