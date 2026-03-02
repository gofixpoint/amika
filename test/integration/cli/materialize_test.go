package cli_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/test/testutil"
)

func TestMaterializeCmd(t *testing.T) {
	testutil.RequireDockerIntegration(t)
	bin := testutil.BuildAmikaBinary(t)
	dest := t.TempDir()

	cmd := exec.Command(
		bin,
		"materialize",
		"--image", "ubuntu:latest",
		"--cmd", "echo integration > result.txt",
		"--destdir", dest,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("materialize failed: %v\n%s", err, string(out))
	}

	data, err := os.ReadFile(filepath.Join(dest, "result.txt"))
	if err != nil {
		t.Fatalf("failed to read output file: %v", err)
	}
	if string(data) != "integration\n" {
		t.Fatalf("result.txt = %q, want %q", string(data), "integration\\n")
	}
}
