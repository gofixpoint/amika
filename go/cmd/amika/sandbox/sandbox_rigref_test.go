package sandboxcmd

// sandbox_rigref_test.go covers how the rig commands read a rig reference
// (a bare value, ref=, name=, id=, or _self) and what each one sends to the
// API: every reference goes out in the command's one request with its kind, a
// bare value as a plain ref (the server's default) and an explicit name= or
// id= with a by/sandbox_by selector. That each command parses its reference
// before the auth check is covered from package main, against the real root.

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// New registers flags on the package's singleton commands, so it may run only
// once per process; the tests share the one real tree it builds.
var (
	rigTreeOnce sync.Once
	rigTreeRoot *cobra.Command
)

// resetChangedFlags restores every flag a run changed to its default across
// the tree, since Cobra never resets flag values or their Changed state.
func resetChangedFlags(cmd *cobra.Command) {
	cmd.Flags().VisitAll(func(f *pflag.Flag) {
		if f.Changed {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		}
	})
	for _, child := range cmd.Commands() {
		resetChangedFlags(child)
	}
}

// runRigCommand runs `amika rig <args>` through the real command tree from
// New, with flag state reset before and after, and returns its stdout.
func runRigCommand(t *testing.T, args ...string) (string, error) {
	t.Helper()
	rigTreeOnce.Do(func() {
		rigTreeRoot = &cobra.Command{Use: "amika", SilenceUsage: true, SilenceErrors: true}
		output.AddFlag(rigTreeRoot)
		rigTreeRoot.AddCommand(New())
	})
	resetChangedFlags(rigTreeRoot)
	t.Cleanup(func() { resetChangedFlags(rigTreeRoot) })
	var out bytes.Buffer
	rigTreeRoot.SetOut(&out)
	rigTreeRoot.SetErr(&bytes.Buffer{})
	rigTreeRoot.SetArgs(append([]string{"rig"}, args...))
	err := rigTreeRoot.Execute()
	return out.String(), err
}

// rigRefServer fakes the sandbox API. Every sandbox it returns is "box" with
// id "sb_1", stopped once a stop was requested; a reference value of
// "missing" is refused as not found. It records each request as "METHOD URI".
func rigRefServer(t *testing.T) *[]string {
	t.Helper()
	var requests []string
	stopped := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.RequestURI)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/sandboxes/missing"):
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"not_found","message":"no such sandbox"}`))
		case strings.HasSuffix(r.URL.Path, "/bindings") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"items":[{"id":"sbind_1","target_namespace":"github","target_kind":"branch","target_url":"https://github.com/o/r/tree/b"}]}`))
		case strings.HasSuffix(r.URL.Path, "/bindings"):
			_, _ = w.Write([]byte(`{"id":"sbind_1"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/stop"):
			stopped = true
			w.WriteHeader(http.StatusAccepted)
		case strings.HasSuffix(r.URL.Path, "/start"):
			w.WriteHeader(http.StatusAccepted)
		default:
			state := "active"
			if stopped {
				state = "stopped"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "sb_1", "name": "box", "state": state, "services": []any{}})
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")
	return &requests
}

// stubSessionSSH replaces the session preparation and the ssh exec, recording
// the identity the alias was built from.
func stubSessionSSH(t *testing.T) *[]string {
	t.Helper()
	var prepared []string
	prevPrepare, prevExec := prepareSessionTarget, execSessionSSH
	prepareSessionTarget = func(_ basedir.Paths, _ ssh.SessionCreator, name, id string) (string, error) {
		prepared = append(prepared, name+"/"+id)
		return name + "." + id + ".test.amika", nil
	}
	execSessionSSH = func(string, []string) error { return nil }
	t.Cleanup(func() { prepareSessionTarget, execSessionSSH = prevPrepare, prevExec })
	return &prepared
}

// TestRigCommandsSendReferenceKinds checks that each command sends a pinned
// reference with its kind in one request, which the server resolves with no
// lookup beforehand, and how the hidden --rig-by combines with a prefix.
func TestRigCommandsSendReferenceKinds(t *testing.T) {
	const base = "/api/v0beta1/sandboxes/"
	cases := []struct {
		name    string
		args    []string
		want    []string
		wantErr string
	}{
		{"get id=", []string{"get", "id=sb_1"}, []string{"GET " + base + "sb_1?by=id"}, ""},
		{"start id=", []string{"start", "id=sb_1"}, []string{"POST " + base + "sb_1/start?by=id", "GET " + base + "sb_1?by=id"}, ""},
		{"stop name=", []string{"stop", "name=box"}, []string{"POST " + base + "box/stop?by=name", "GET " + base + "box?by=name"}, ""},
		{"delete mixed", []string{"delete", "--force", "box", "name=box", "id=sb_1"}, []string{
			"DELETE " + base + "box", "DELETE " + base + "box?by=name", "DELETE " + base + "sb_1?by=id",
		}, ""},
		{"connect id=", []string{"connect", "id=sb_1"}, []string{"GET " + base + "sb_1?by=id"}, ""},
		{"bind name=", []string{"bind", "name=box", "gh-branch:o/r/b"}, []string{"POST " + base + "box/bindings?sandbox_by=name"}, ""},
		{"bindings list id=", []string{"bindings", "list", "--rig", "id=sb_1"}, []string{"GET " + base + "sb_1/bindings?sandbox_by=id"}, ""},
		{"bindings delete id=", []string{"bindings", "delete", "--force", "id=sb_1", "gh-branch:o/r/b"}, []string{
			"GET " + base + "sb_1/bindings?sandbox_by=id", "DELETE /api/v0beta1/sandbox-bindings/sbind_1",
		}, ""},
		// The hidden --rig-by still works as the legacy spelling of a prefix.
		{"bind --rig-by", []string{"bind", "--rig-by", "id", "sb_1", "gh-branch:o/r/b"}, []string{"POST " + base + "sb_1/bindings?sandbox_by=id"}, ""},
		{"bindings list --rig-by", []string{"bindings", "list", "--rig", "box", "--rig-by", "name"}, []string{"GET " + base + "box/bindings?sandbox_by=name"}, ""},
		// A prefix wins over --rig-by's default and may repeat its kind, but
		// one that disagrees with an explicit --rig-by is refused.
		{"bindings list prefix over default", []string{"bindings", "list", "--rig", "name=box", "--rig-by", "ref"}, []string{"GET " + base + "box/bindings?sandbox_by=name"}, ""},
		{"bindings list agreeing prefix", []string{"bindings", "list", "--rig", "name=box", "--rig-by", "name"}, []string{"GET " + base + "box/bindings?sandbox_by=name"}, ""},
		{"bindings list conflict", []string{"bindings", "list", "--rig", "id=sb_1", "--rig-by", "name"}, nil, "conflicts with the id= prefix"},
		{"bind --rig-by conflict", []string{"bind", "--rig-by", "id", "name=box", "gh-branch:o/r/b"}, nil, "conflicts with the name= prefix"},
		{"bind --rig-by id with _self", []string{"bind", "--rig-by", "id", "_self", "gh-branch:o/r/b"}, nil, "not its id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AMIKA_RIG_NAME", "here")
			requests := rigRefServer(t)
			stubSessionSSH(t)
			out, err := runRigCommand(t, tc.args...)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %v, want one containing %q", err, tc.wantErr)
				}
			} else if err != nil {
				t.Fatalf("rig %v: %v\n%s", tc.args, err, out)
			}
			if !reflect.DeepEqual(*requests, tc.want) {
				t.Fatalf("requests = %q, want %q", *requests, tc.want)
			}
		})
	}
}

func TestRigConnectUsesCanonicalIdentity(t *testing.T) {
	rigRefServer(t)
	prepared := stubSessionSSH(t)
	if _, err := runRigCommand(t, "connect", "id=sb_1"); err != nil {
		t.Fatal(err)
	}
	// The alias is built from what the API returned, never from "id=sb_1".
	if want := []string{"box/sb_1"}; !reflect.DeepEqual(*prepared, want) {
		t.Fatalf("prepared = %q, want %q", *prepared, want)
	}
}

func TestRigBatchOutputNamesRigs(t *testing.T) {
	t.Run("JSON names each rig as the user wrote it", func(t *testing.T) {
		rigRefServer(t)
		out, err := runRigCommand(t, "delete", "--force", "-o", "json", "name=box", "id=missing")
		if err == nil {
			t.Fatal("want an error for the missing rig")
		}
		var results []output.ItemResult
		if err := json.Unmarshal([]byte(out), &results); err != nil {
			t.Fatalf("decode %q: %v", out, err)
		}
		if len(results) != 2 || results[0].Name != "name=box" || results[0].Status != "deleted" ||
			results[1].Name != "id=missing" || results[1].Status != "error" {
			t.Fatalf("results = %+v", results)
		}
	})

	t.Run("start reports the canonical name once it is known", func(t *testing.T) {
		rigRefServer(t)
		out, err := runRigCommand(t, "start", "id=sb_1")
		if err != nil {
			t.Fatal(err)
		}
		if want := "Rig \"id=sb_1\" starting...\nRig \"box\" started\n"; out != want {
			t.Fatalf("output = %q, want %q", out, want)
		}
	})

	t.Run("delete shows the name _self stands for", func(t *testing.T) {
		t.Setenv("AMIKA_RIG_NAME", "here")
		rigRefServer(t)
		out, err := runRigCommand(t, "delete", "--force", "-o", "json", "_self")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, `"name":"here"`) {
			t.Fatalf("output = %s, want the rig named here", out)
		}
	})
}

// isolateOutsideRigUnauthenticated leaves the process with no credential
// source and no rig name, so a command that checks auth before resolving
// "_self" would report a login prompt instead of ErrNotInRig.
func isolateOutsideRigUnauthenticated(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for key, value := range map[string]string{
		"AMIKA_API_KEY":         "",
		"HOME":                  dir,
		"XDG_CONFIG_HOME":       dir,
		"XDG_STATE_HOME":        dir,
		"XDG_DATA_HOME":         dir,
		"AMIKA_STATE_DIRECTORY": dir,
		rigref.RigNameEnv:       "",
		rigref.SandboxNameEnv:   "",
	} {
		t.Setenv(key, value)
	}
}

// TestSSHReferenceParsedBeforeAuth checks that `rig ssh` reports a malformed
// reference, or a "_self" outside a rig, as itself rather than behind a login
// prompt, and never runs ssh for it.
func TestSSHReferenceParsedBeforeAuth(t *testing.T) {
	for _, tc := range []struct {
		ref   string
		check func(error) bool
	}{
		{"id=", func(err error) bool { return err != nil && strings.Contains(err.Error(), "no value") }},
		{rigref.Self, func(err error) bool { return errors.Is(err, rigref.ErrNotInRig) }},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", tc.ref})
			isolateOutsideRigUnauthenticated(t)
			if err := root.Execute(); !tc.check(err) {
				t.Fatalf("error = %v, want the reference's own error", err)
			}
			if h.ran {
				t.Fatal("ssh ran for an unusable reference")
			}
		})
	}
}

// TestSSHResolvesReferenceToAlias checks that `rig ssh` looks a prefixed
// reference up by its kind and puts only the resulting alias on the ssh
// command line, never the "id=..." token itself.
func TestSSHResolvesReferenceToAlias(t *testing.T) {
	root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", "-N", "id=sb_abc", "uptime"})
	stub := &stubV2SSHClient{sandbox: &apiclient.RemoteSandbox{Name: "my-box", ID: "sb_abc"}}
	newSSHV2Client = func(string) (sshV2Client, error) { return stub, nil }
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if want := []apiclient.SandboxSelector{{Value: "sb_abc", By: apiclient.SelectByID}}; !reflect.DeepEqual(stub.looked, want) {
		t.Fatalf("GetSandbox selectors = %#v, want %#v", stub.looked, want)
	}
	if want := []string{"-N", testV2Alias, "uptime"}; !reflect.DeepEqual(h.argv, want) {
		t.Fatalf("ssh argv = %#v, want %#v", h.argv, want)
	}
}
