package sandboxcmd

// sandbox_rigref_test.go covers how the rig commands read a rig reference
// (a bare value, ref=, name=, id=, or _self) and what each one sends to the
// API: a bare value goes out exactly as before selectors existed, and only an
// explicit name= or id= adds a by/sandbox_by selector.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// newRigRefTestRoot builds a fresh amika/rig tree around the real RunE of each
// command that names an existing rig, so every test starts from clean flag
// state instead of sharing the package's singleton commands.
func newRigRefTestRoot() *cobra.Command {
	root := &cobra.Command{Use: "amika", SilenceUsage: true, SilenceErrors: true}
	output.AddFlag(root)
	rig := &cobra.Command{Use: "rig"}
	rig.PersistentFlags().String("remote-target", "", "")
	root.AddCommand(rig)
	add := func(use string, args cobra.PositionalArgs, runE func(*cobra.Command, []string) error) *cobra.Command {
		cmd := &cobra.Command{Use: use, Args: args, RunE: runE}
		rig.AddCommand(cmd)
		return cmd
	}
	add("get", cobra.ExactArgs(1), runSandboxGet)
	add("start", cobra.MinimumNArgs(1), sandboxStartCmd.RunE)
	add("stop", cobra.MinimumNArgs(1), sandboxStopCmd.RunE)
	add("delete", cobra.MinimumNArgs(1), sandboxDeleteCmd.RunE).Flags().Bool("force", false, "")
	add("connect", cobra.ExactArgs(1), sandboxConnectCmd.RunE)
	open := add("open", cobra.ExactArgs(1), sandboxCodeV2Cmd.RunE)
	open.Flags().String("app", "cursor", "")
	open.Flags().String("editor", "", "")
	open.Flags().String("path", "", "")
	bind := add("bind", cobra.ExactArgs(2), sandboxBindCmd.RunE)
	bind.Flags().Bool("rebind", false, "")
	bind.Flags().String("rig-by", "ref", "")
	bindingsList := add("bindings-list", cobra.NoArgs, runSandboxBindingsList)
	bindingsList.Flags().String("rig", "", "")
	bindingsList.Flags().String("rig-by", "ref", "")
	bindingsDelete := add("bindings-delete", cobra.RangeArgs(1, 2), runSandboxBindingsDelete)
	bindingsDelete.Flags().String("rig-by", "ref", "")
	bindingsDelete.Flags().Bool("force", false, "")
	return root
}

// rigRefServer fakes the sandbox API. Every sandbox it returns is "box" with
// id "sb_1", stopped once a stop was requested; a reference value of "dup" is
// refused as ambiguous and "missing" as not found. It records each request as
// "METHOD URI".
func rigRefServer(t *testing.T) *[]string {
	t.Helper()
	var requests []string
	stopped := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.RequestURI)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/sandboxes/dup"):
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"resource_ref_ambiguous","message":"more than one sandbox matches"}`))
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

func runRigRefCommand(t *testing.T, args ...string) (string, error) {
	t.Helper()
	root := newRigRefTestRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs(append([]string{"rig"}, args...))
	err := root.Execute()
	return out.String(), err
}

func TestRigCommandsSendReferenceKinds(t *testing.T) {
	const base = "/api/v0beta1/sandboxes/"
	cases := []struct {
		name string
		args []string
		want []string
	}{
		{"get bare", []string{"get", "box"}, []string{"GET " + base + "box"}},
		{"get ref=", []string{"get", "ref=box"}, []string{"GET " + base + "box"}},
		{"get name=", []string{"get", "name=box"}, []string{"GET " + base + "box?by=name"}},
		{"get id=", []string{"get", "id=sb_1"}, []string{"GET " + base + "sb_1?by=id"}},
		// _self names the current rig but goes out as a plain ref, the way
		// every reference did before the API took selectors.
		{"get _self", []string{"get", "_self"}, []string{"GET " + base + "box"}},
		{"get name=_self", []string{"get", "name=_self"}, []string{"GET " + base + "box?by=name"}},
		// start, stop, and delete route a name= or id= rig through its
		// canonical id, after a lookup that checks the pinned field, since a
		// server that predates `by` on those routes would ignore it.
		{"start id=", []string{"start", "id=sb_1"}, []string{"GET " + base + "sb_1?by=id", "POST " + base + "sb_1/start", "GET " + base + "sb_1"}},
		{"stop name=", []string{"stop", "name=box"}, []string{"GET " + base + "box?by=name", "POST " + base + "sb_1/stop", "GET " + base + "sb_1"}},
		{"delete mixed", []string{"delete", "--force", "box", "name=box", "id=sb_1"}, []string{
			"DELETE " + base + "box",
			"GET " + base + "box?by=name", "DELETE " + base + "sb_1",
			"GET " + base + "sb_1?by=id", "DELETE " + base + "sb_1",
		}},
		{"connect id=", []string{"connect", "id=sb_1"}, []string{"GET " + base + "sb_1?by=id"}},
		{"bind name=", []string{"bind", "name=box", "gh-branch:o/r/b"}, []string{"POST " + base + "box/bindings?sandbox_by=name"}},
		{"bind bare", []string{"bind", "box", "gh-branch:o/r/b"}, []string{"POST " + base + "box/bindings?sandbox_by=ref"}},
		// The hidden --rig-by still works as the legacy spelling of a prefix.
		{"bind --rig-by", []string{"bind", "--rig-by", "id", "sb_1", "gh-branch:o/r/b"}, []string{"POST " + base + "sb_1/bindings?sandbox_by=id"}},
		{"bindings list id=", []string{"bindings-list", "--rig", "id=sb_1"}, []string{"GET " + base + "sb_1/bindings?sandbox_by=id"}},
		{"bindings list --rig-by", []string{"bindings-list", "--rig", "box", "--rig-by", "name"}, []string{"GET " + base + "box/bindings?sandbox_by=name"}},
		// A prefix wins over --rig-by's default.
		{"bindings list prefix over default", []string{"bindings-list", "--rig", "name=box", "--rig-by", "ref"}, []string{"GET " + base + "box/bindings?sandbox_by=name"}},
		{"bindings list agreeing prefix", []string{"bindings-list", "--rig", "name=box", "--rig-by", "name"}, []string{"GET " + base + "box/bindings?sandbox_by=name"}},
		{"bindings delete id=", []string{"bindings-delete", "--force", "id=sb_1", "gh-branch:o/r/b"}, []string{
			"GET " + base + "sb_1/bindings?sandbox_by=id", "DELETE /api/v0beta1/sandbox-bindings/sbind_1",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AMIKA_RIG_NAME", "box")
			requests := rigRefServer(t)
			stubSessionSSH(t)
			if out, err := runRigRefCommand(t, tc.args...); err != nil {
				t.Fatalf("rig %v: %v\n%s", tc.args, err, out)
			}
			if !reflect.DeepEqual(*requests, tc.want) {
				t.Fatalf("requests = %q, want %q", *requests, tc.want)
			}
		})
	}
}

// The stub server answers every lookup with the rig named "box" whose id is
// "sb_1", the way a server that ignores `by` matches id or name. A pinned
// reference to the other field must be refused before anything acts on that
// rig.
func TestPinnedRigRefusesAMismatchedRig(t *testing.T) {
	for _, args := range [][]string{
		{"delete", "--force", "id=box"},
		{"stop", "name=sb_1"},
		{"start", "id=box"},
		{"get", "id=box"},
		{"connect", "name=sb_1"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			requests := rigRefServer(t)
			stubSessionSSH(t)
			out, err := runRigRefCommand(t, args...)
			if err == nil {
				t.Fatalf("rig %v succeeded against a rig it does not name\n%s", args, out)
			}
			for _, req := range *requests {
				if !strings.HasPrefix(req, "GET ") {
					t.Fatalf("rig %v sent %q after a mismatched lookup", args, req)
				}
			}
		})
	}
}

func TestRigConnectUsesCanonicalIdentity(t *testing.T) {
	rigRefServer(t)
	prepared := stubSessionSSH(t)
	if _, err := runRigRefCommand(t, "connect", "id=sb_1"); err != nil {
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
		out, err := runRigRefCommand(t, "delete", "--force", "-o", "json", "name=box", "id=missing")
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
		out, err := runRigRefCommand(t, "start", "id=sb_1")
		if err != nil {
			t.Fatal(err)
		}
		if want := "Sandbox \"id=sb_1\" starting...\nSandbox \"box\" started\n"; out != want {
			t.Fatalf("output = %q, want %q", out, want)
		}
	})

	t.Run("delete shows the name _self stands for", func(t *testing.T) {
		t.Setenv("AMIKA_RIG_NAME", "here")
		rigRefServer(t)
		out, err := runRigRefCommand(t, "delete", "--force", "-o", "json", "_self")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, `"name":"here"`) {
			t.Fatalf("output = %s, want the rig named here", out)
		}
	})
}

func TestRigAmbiguousReferenceSuggestsPrefixes(t *testing.T) {
	rigRefServer(t)
	_, err := runRigRefCommand(t, "get", "dup")
	if err == nil || !strings.Contains(err.Error(), `use "id=dup" or "name=dup"`) {
		t.Fatalf("error = %v, want a hint naming id=dup and name=dup", err)
	}
}

// TestRigReferenceParsedBeforeAuth checks that a malformed reference is
// reported as itself, not hidden behind a login prompt, for every command
// that names a rig.
func TestRigReferenceParsedBeforeAuth(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"get", []string{"get", "id="}, "no value"},
		{"start", []string{"start", "box", "name="}, "no value"},
		{"stop", []string{"stop", "id=_self"}, "not its id"},
		{"delete", []string{"delete", "--force", "box", "id="}, "no value"},
		{"connect", []string{"connect", "name="}, "no value"},
		{"open", []string{"open", "id="}, "no value"},
		{"bind", []string{"bind", "id=", "gh-branch:o/r/b"}, "no value"},
		{"bind --rig-by conflict", []string{"bind", "--rig-by", "id", "name=box", "gh-branch:o/r/b"}, "conflicts with the name= prefix"},
		{"bind --rig-by id with _self", []string{"bind", "--rig-by", "id", "_self", "gh-branch:o/r/b"}, "not its id"},
		{"bindings list", []string{"bindings-list", "--rig", "id="}, "no value"},
		{"bindings list conflict", []string{"bindings-list", "--rig", "id=sb_1", "--rig-by", "name"}, "conflicts with the id= prefix"},
		{"bindings delete", []string{"bindings-delete", "--force", "name=", "gh-branch:o/r/b"}, "no value"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolateOutsideRigUnauthenticated(t)
			_, err := runRigRefCommand(t, tc.args...)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}

	t.Run("ssh", func(t *testing.T) {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", "id="})
		isolateOutsideRigUnauthenticated(t)
		if err := root.Execute(); err == nil || !strings.Contains(err.Error(), "no value") {
			t.Fatalf("error = %v, want a missing-value error", err)
		}
		if h.ran {
			t.Fatal("ssh ran for a malformed reference")
		}
	})
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
	if want := []apiclient.SandboxSelector{apiclient.SandboxByID("sb_abc")}; !reflect.DeepEqual(stub.looked, want) {
		t.Fatalf("GetSandbox selectors = %#v, want %#v", stub.looked, want)
	}
	if want := []string{"-N", testV2Alias, "uptime"}; !reflect.DeepEqual(h.argv, want) {
		t.Fatalf("ssh argv = %#v, want %#v", h.argv, want)
	}
}
