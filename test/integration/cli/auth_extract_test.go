package cli_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/test/testutil"
)

func TestSecretExtractHelp(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "secret", "extract", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("secret extract --help failed: %v\n%s", err, string(out))
	}

	output := string(out)
	if !strings.Contains(output, "Discover local API credentials") {
		t.Fatalf("expected help output to mention credential extraction, got:\n%s", output)
	}
}
