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

func TestSecretsExtractHelpContract(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "secrets", "extract", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("secrets extract --help failed: %v\n%s", err, string(out))
	}
	text := string(out)
	if !strings.Contains(text, "--push") {
		t.Fatalf("expected help output to include --push flag, got:\n%s", text)
	}
	if !strings.Contains(text, "--no-oauth") {
		t.Fatalf("expected help output to include --no-oauth flag, got:\n%s", text)
	}
	if !strings.Contains(text, "--only") {
		t.Fatalf("expected help output to include --only flag, got:\n%s", text)
	}
}

func TestSecretsPushHelpContract(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "secrets", "push", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("secrets push --help failed: %v\n%s", err, string(out))
	}
	text := string(out)
	if !strings.Contains(text, "--from-env") {
		t.Fatalf("expected help output to include --from-env flag, got:\n%s", text)
	}
}
