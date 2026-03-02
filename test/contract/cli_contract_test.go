package contract_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/test/testutil"
)

func TestSandboxCreateNoCleanRequiresGit(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--name", "contract-sb", "--no-clean", "--yes")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "--no-clean requires --git") {
		t.Fatalf("expected --no-clean/--git contract error, got:\n%s", string(out))
	}
}

func TestAuthExtractHelpContract(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "auth", "extract", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("auth extract --help failed: %v\n%s", err, string(out))
	}
	text := string(out)
	if !strings.Contains(text, "--export") {
		t.Fatalf("expected help output to include --export flag, got:\n%s", text)
	}
	if !strings.Contains(text, "--no-oauth") {
		t.Fatalf("expected help output to include --no-oauth flag, got:\n%s", text)
	}
}
