package contract_test

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/test/testutil"
)

func TestSandboxCreateNoCleanRejectsNoGit(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--name", "contract-sb", "--no-clean", "--no-git", "--yes")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "--no-clean and --no-git are mutually exclusive") {
		t.Fatalf("expected --no-clean/--no-git contract error, got:\n%s", string(out))
	}
}

func TestSandboxCreateGitAndNoGitConflict(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--name", "contract-sb", "--git", "https://example.com/x/y.git", "--no-git", "--yes")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "--git and --no-git are mutually exclusive") {
		t.Fatalf("expected --git/--no-git contract error, got:\n%s", string(out))
	}
}

func TestSandboxCreateNoCleanRejectsRemote(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--name", "contract-sb", "--no-clean", "--remote", "--yes")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "--no-clean is only supported for local sandboxes") {
		t.Fatalf("expected --no-clean/remote contract error, got:\n%s", string(out))
	}
}

func TestSecretExtractHelpContract(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "secret", "extract", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("secret extract --help failed: %v\n%s", err, string(out))
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

func TestSecretPushHelpContract(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "secret", "push", "--help")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("secret push --help failed: %v\n%s", err, string(out))
	}
	text := string(out)
	if !strings.Contains(text, "--from-env") {
		t.Fatalf("expected help output to include --from-env flag, got:\n%s", text)
	}
}

func TestSandboxCreateInvalidGithubAuthModeFailsEarly(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--remote", "--github-auth-mode", "invalid", "--no-git")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "unknown github-auth-mode") {
		t.Fatalf("expected unknown github-auth-mode error, got:\n%s", string(out))
	}
}

func TestSandboxCreateGithubAuthModeRequiresRemote(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--local", "--github-auth-mode", "pat", "--no-git")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "--github-auth-mode requires --remote mode") {
		t.Fatalf("expected --github-auth-mode remote-only error, got:\n%s", string(out))
	}
}
