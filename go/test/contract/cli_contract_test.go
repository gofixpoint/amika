package contract_test

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/test/testutil"
)

func TestSandboxCreateGitAndNoGitConflict(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	cmd := exec.Command(bin, "sandbox", "create", "--name", "contract-sb", "--git", "https://example.com/x/y.git", "--no-git")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
	}
	if !strings.Contains(string(out), "--git and --no-git are mutually exclusive") {
		t.Fatalf("expected --git/--no-git contract error, got:\n%s", string(out))
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

// --host's own validation runs ahead of the auth gate, like the two above, so
// an unauthenticated caller sees the flag error rather than a login error.
func TestSandboxCreateHostFlagFailsEarly(t *testing.T) {
	bin := testutil.BuildAmikaBinary(t)

	tests := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "empty value",
			args: []string{"--host", "", "--no-git"},
			want: "--host needs a hostname or id",
		},
		{
			name: "with --snapshot",
			args: []string{"--host", "alpha.lan", "--snapshot", "base", "--no-git"},
			want: "--snapshot cannot be combined with --host",
		},
		{
			// Driven through the real binary, so this also pins that the
			// create command still registers --provider: createHostRef reads
			// it with the error discarded, so losing the registration would
			// silently stop rejecting the pair and send it to the server.
			name: "with --provider",
			args: []string{"--host", "alpha.lan", "--provider", "e2b", "--no-git"},
			want: "--provider cannot be combined with --host",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := exec.Command(bin, append([]string{"sandbox", "create", "--remote"}, tt.args...)...)
			// Scrubbed credentials, or this proves nothing: AMIKA_API_KEY is
			// set inside an Amika rig, which is where this suite usually runs,
			// and RequireAuth returns nil the moment it sees one. The flag
			// error would then be indistinguishable from the login error that
			// a regression in the ordering should produce -- and a regression
			// in the empty-value guard would run the create to completion
			// against a real organization.
			cmd.Env = append(os.Environ(),
				"AMIKA_API_KEY=",
				"HOME="+t.TempDir(),
				"AMIKA_STATE_DIRECTORY="+t.TempDir(),
			)
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatalf("expected sandbox create to fail, output:\n%s", string(out))
			}
			if !strings.Contains(string(out), tt.want) {
				t.Fatalf("expected %q, got:\n%s", tt.want, string(out))
			}
		})
	}
}
