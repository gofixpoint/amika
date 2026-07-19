package main

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/auth"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// resetChangedFlags restores every flag that a run mutated back to its default
// across the whole command tree, so state (e.g. --output or --force) does not
// leak between tests that share the global rootCmd.
func resetChangedFlags(cmd *cobra.Command) {
	cmd.Flags().VisitAll(func(f *pflag.Flag) {
		if f.Changed {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		}
	})
	for _, c := range cmd.Commands() {
		resetChangedFlags(c)
	}
}

// runRootCommandOutput runs the root command with mutated-flag isolation: it
// resets flags both before the run (in case a sibling test that used the plain
// runRootCommand helper left state behind) and after (via t.Cleanup, so it runs
// regardless of how the test returns).
func runRootCommandOutput(t *testing.T, args ...string) (string, error) {
	t.Helper()
	resetChangedFlags(rootCmd)
	t.Cleanup(func() { resetChangedFlags(rootCmd) })
	return runRootCommand(args...)
}

func TestVolumeListJSON_EmptyIsEmptyArray(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())

	out, err := runRootCommandOutput(t, "volume", "list", "-o", "json")
	if err != nil {
		t.Fatalf("volume list -o json failed: %v", err)
	}
	if out != "[]\n" {
		t.Fatalf("empty volume list JSON = %q, want %q", out, "[]\n")
	}
}

func TestVolumeListJSON_ItemFields(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", stateDir)

	store := sandbox.NewVolumeStore(filepath.Join(stateDir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{
		Name:        "vol-1",
		CreatedAt:   "2026-01-02T00:00:00Z",
		SourcePath:  "/host/data",
		SandboxRefs: []string{"sb-a"},
	}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	out, err := runRootCommandOutput(t, "volume", "list", "-o", "json")
	if err != nil {
		t.Fatalf("volume list -o json failed: %v", err)
	}
	for _, want := range []string{
		`"name":"vol-1"`,
		`"type":"directory"`,
		`"in_use":true`,
		`"sandboxes":["sb-a"]`,
		`"source_path":"/host/data"`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("volume list JSON missing %q, got:\n%s", want, out)
		}
	}
}

func TestVolumeDeleteJSON_MissingReportsError(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())

	out, err := runRootCommandOutput(t, "volume", "delete", "ghost", "--force", "-o", "json")
	if err == nil {
		t.Fatal("expected a non-nil error when deletion fails")
	}
	for _, want := range []string{`"name":"ghost"`, `"status":"error"`, "no volume found"} {
		if !strings.Contains(out, want) {
			t.Fatalf("volume delete JSON missing %q, got:\n%s", want, out)
		}
	}
}

func TestVolumeDeleteJSON_RequiresForce(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())

	_, err := runRootCommandOutput(t, "volume", "delete", "ghost", "-o", "json")
	if err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("expected a --force requirement error, got %v", err)
	}
}

func TestAuthLogoutJSON_NothingStored(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())

	out, err := runRootCommandOutput(t, "auth", "logout", "-o", "json")
	if err != nil {
		t.Fatalf("auth logout -o json failed: %v", err)
	}
	if !strings.Contains(out, `"cleared_api_key":false`) || !strings.Contains(out, `"cleared_session":false`) {
		t.Fatalf("unexpected logout JSON: %s", out)
	}
}

func TestInteractiveCommandsRejectJSON(t *testing.T) {
	for _, args := range [][]string{
		{"sandbox", "connect", "somebox", "-o", "json"},
		{"sandbox", "code", "somebox", "-o", "json"},
		{"sandbox", "connect", "somebox", "-o", "json-pretty"},
	} {
		_, err := runRootCommandOutput(t, args...)
		if err == nil {
			t.Fatalf("%v: expected error rejecting JSON output", args)
		}
		if !strings.Contains(err.Error(), "interactive session") {
			t.Fatalf("%v: unexpected error: %v", args, err)
		}
	}
}

func TestInvalidOutputValue_FailsOnNonJSONCommand(t *testing.T) {
	// version does not emit JSON, but the root PersistentPreRunE must still
	// reject an invalid --output value.
	_, err := runRootCommandOutput(t, "version", "-o", "bogus")
	if err == nil {
		t.Fatal("expected an error for invalid --output value")
	}
	if !strings.Contains(err.Error(), "invalid --output") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBuildAuthStatusJSON(t *testing.T) {
	session := &auth.WorkOSSession{Email: "user@example.com", OrgID: "org_123"}
	key := &auth.APIKeyAuth{Key: "secret"}
	loadErr := errors.New("boom")

	cases := []struct {
		name          string
		envKeySet     bool
		storedKey     *auth.APIKeyAuth
		keyErr        error
		session       *auth.WorkOSSession
		sessErr       error
		wantAuth      bool
		wantMethod    string
		wantEmail     string
		wantOrg       string
		wantWarnParts []string
	}{
		{
			name:       "env api key",
			envKeySet:  true,
			wantAuth:   true,
			wantMethod: "env_api_key",
		},
		{
			name:          "env api key shadows stored key and session",
			envKeySet:     true,
			storedKey:     key,
			session:       session,
			wantAuth:      true,
			wantMethod:    "env_api_key",
			wantWarnParts: []string{"shadows stored API key", "shadows logged-in session: user@example.com (org: org_123)"},
		},
		{
			name:       "stored api key",
			storedKey:  key,
			wantAuth:   true,
			wantMethod: "stored_api_key",
		},
		{
			name:       "session",
			session:    session,
			wantAuth:   true,
			wantMethod: "session",
			wantEmail:  "user@example.com",
			wantOrg:    "org_123",
		},
		{
			name:       "not logged in",
			wantMethod: "none",
		},
		{
			name:          "unreadable files carry recovery hint",
			keyErr:        loadErr,
			sessErr:       loadErr,
			wantMethod:    "none",
			wantWarnParts: []string{"stored API key file is unreadable (boom); run `amika auth logout`", "stored session file is unreadable (boom); run `amika auth logout`"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildAuthStatusJSON(tc.envKeySet, tc.storedKey, tc.keyErr, tc.session, tc.sessErr, "/key/path", "/session/path")
			if got.Authenticated != tc.wantAuth {
				t.Errorf("Authenticated = %v, want %v", got.Authenticated, tc.wantAuth)
			}
			if got.Method != tc.wantMethod {
				t.Errorf("Method = %q, want %q", got.Method, tc.wantMethod)
			}
			if got.Email != tc.wantEmail {
				t.Errorf("Email = %q, want %q", got.Email, tc.wantEmail)
			}
			if got.OrgID != tc.wantOrg {
				t.Errorf("OrgID = %q, want %q", got.OrgID, tc.wantOrg)
			}
			if got.Warnings == nil {
				t.Fatal("Warnings must never be nil (should marshal as [])")
			}
			for _, part := range tc.wantWarnParts {
				found := false
				for _, w := range got.Warnings {
					if strings.Contains(w, part) {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("warnings %v missing %q", got.Warnings, part)
				}
			}
			if len(tc.wantWarnParts) == 0 && len(got.Warnings) != 0 {
				t.Errorf("expected no warnings, got %v", got.Warnings)
			}
		})
	}
}
