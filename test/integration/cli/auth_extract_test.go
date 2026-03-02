package cli_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/test/testutil"
)

func TestAuthExtractHelp(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "auth", "extract", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("auth extract --help failed: %v\n%s", err, string(out))
	}

	output := string(out)
	if !strings.Contains(output, "Discover local API credentials") {
		t.Fatalf("expected help output to mention credential extraction, got:\n%s", output)
	}
}
