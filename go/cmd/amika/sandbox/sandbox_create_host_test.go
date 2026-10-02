package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
	"github.com/gofixpoint/amika/go/internal/output"
)

// newHostListClient serves a two-host listing: one ready, one with no URL.
func newHostListClient(t *testing.T) *apiclient.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `[
		  {"id":"host_1","hostname":"alpha.lan","url":"https://alpha.example","org_id":"org_1",
		   "sizes":{},"created_at":"","updated_at":""},
		  {"id":"host_2","hostname":"beta.lan","url":null,"org_id":"org_1",
		   "sizes":{},"created_at":"","updated_at":""}
		]`)
	}))
	t.Cleanup(srv.Close)
	return apiclient.NewClient(srv.URL, "tok")
}

func TestResolveCreateHost(t *testing.T) {
	client := newHostListClient(t)

	t.Run("no --host leaves the rig on Amika Cloud", func(t *testing.T) {
		// Resolved without a request: the empty id is what the create omits.
		id, err := resolveCreateHost(nil, "")
		if err != nil || id != "" {
			t.Errorf("got %q, %v", id, err)
		}
	})

	t.Run("resolves a hostname to its id", func(t *testing.T) {
		id, err := resolveCreateHost(client, "alpha.lan")
		if err != nil || id != "host_1" {
			t.Errorf("got %q, %v", id, err)
		}
	})

	t.Run("accepts an id too", func(t *testing.T) {
		id, err := resolveCreateHost(client, "host_1")
		if err != nil || id != "host_1" {
			t.Errorf("got %q, %v", id, err)
		}
	})

	t.Run("refuses a host with no URL", func(t *testing.T) {
		_, err := resolveCreateHost(client, "beta.lan")
		if err == nil || !strings.Contains(err.Error(), "register-url") {
			t.Errorf("err = %v, want one pointing at register-url", err)
		}
	})

	t.Run("reports an unknown host", func(t *testing.T) {
		_, err := resolveCreateHost(client, "gamma.lan")
		if err == nil || !strings.Contains(err.Error(), "alpha.lan") {
			t.Errorf("err = %v, want one naming the known hosts", err)
		}
	})
}

// --host selects one of the org's own hosts and nothing else: naming the
// default is a mistake with a specific fix, not a missing host.
func TestResolveCreateHostRejectsNamingAmikaCloud(t *testing.T) {
	client := newHostListClient(t)
	for _, ref := range []string{"amika-cloud", "Amika Cloud", "amika", "cloud", "AMIKACLOUD"} {
		_, err := resolveCreateHost(client, ref)
		if err == nil || !strings.Contains(err.Error(), "omit --host") {
			t.Errorf("resolveCreateHost(%q) = %v, want the omit-the-flag error", ref, err)
		}
	}
}

// createHostRef owns everything about --host that needs no network, so each
// of these fails before the auth gate and before any request.
func TestCreateHostRef(t *testing.T) {
	newCmd := func() *cobra.Command {
		c := &cobra.Command{}
		c.Flags().String("host", "", "")
		c.Flags().String("snapshot", "", "")
		c.Flags().String("provider", "", "")
		return c
	}

	t.Run("absent flag runs on Amika Cloud", func(t *testing.T) {
		ref, err := createHostRef(newCmd())
		if err != nil || ref != "" {
			t.Errorf("got %q, %v", ref, err)
		}
	})

	// The flag name is read with the error discarded, so a typo in it would
	// silently behave like an absent flag; this pins the spelling.
	t.Run("reads the flag", func(t *testing.T) {
		c := newCmd()
		c.Flags().Set("host", "  alpha.lan  ")
		ref, err := createHostRef(c)
		if err != nil || ref != "alpha.lan" {
			t.Errorf("got %q, %v", ref, err)
		}
	})

	// An unset "$AMIKA_HOST" must not quietly land the rig on Amika Cloud.
	t.Run("refuses an explicitly empty value", func(t *testing.T) {
		for _, value := range []string{"", "   "} {
			c := newCmd()
			c.Flags().Set("host", value)
			_, err := createHostRef(c)
			if err == nil || !strings.Contains(err.Error(), "needs a hostname or id") {
				t.Errorf("createHostRef(%q) = %v, want the empty-value error", value, err)
			}
		}
	})

	// Each conflict gets its own reason: a base-image sentence explains
	// --snapshot and says nothing at all about --provider.
	t.Run("refuses the flags a host rig cannot honor", func(t *testing.T) {
		for _, tt := range []struct{ flag, why string }{
			{"snapshot", "boots its preset's base image"},
			{"provider", "not on a cloud provider"},
		} {
			c := newCmd()
			c.Flags().Set("host", "alpha.lan")
			c.Flags().Set(tt.flag, "x")
			_, err := createHostRef(c)
			if err == nil || !strings.Contains(err.Error(), "--"+tt.flag+" cannot be combined with --host") {
				t.Errorf("with --%s: err = %v", tt.flag, err)
			}
			if err != nil && !strings.Contains(err.Error(), tt.why) {
				t.Errorf("with --%s: err = %v, want the reason %q", tt.flag, err, tt.why)
			}
		}
	})

	// An empty value for either is dropped from the request body anyway, so
	// the same invocation without --host already succeeds; refusing it here
	// would break a script the moment it added --host to an unset "$SNAP".
	t.Run("ignores an empty value for those flags", func(t *testing.T) {
		for _, conflict := range []string{"snapshot", "provider"} {
			c := newCmd()
			c.Flags().Set("host", "alpha.lan")
			c.Flags().Set(conflict, "")
			ref, err := createHostRef(c)
			if err != nil || ref != "alpha.lan" {
				t.Errorf("with --%s \"\": got %q, %v", conflict, ref, err)
			}
		}
	})

	// But whitespace is a value, not an absence: the send path forwards it
	// verbatim, so letting it past here would turn a clear local error into
	// a 400 from the API.
	t.Run("refuses a whitespace-only value for those flags", func(t *testing.T) {
		for _, conflict := range []string{"snapshot", "provider"} {
			c := newCmd()
			c.Flags().Set("host", "alpha.lan")
			c.Flags().Set(conflict, "  ")
			if _, err := createHostRef(c); err == nil {
				t.Errorf("with --%s \"  \": want an error", conflict)
			}
		}
	})
}

// A listing that failed is not a ref that matched nothing. The hint would
// otherwise bury an auth, network, or decode failure behind advice to drop a
// flag that was never the problem.
func TestResolveCreateHostKeepsAListingFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":"boom"}`)
	}))
	defer srv.Close()
	client := apiclient.NewClient(srv.URL, "tok")

	for _, ref := range []string{"cloud", "alpha.lan"} {
		_, err := resolveCreateHost(client, ref)
		if err == nil {
			t.Fatalf("resolveCreateHost(%q): want an error", ref)
		}
		if strings.Contains(err.Error(), "omit --host") {
			t.Errorf("resolveCreateHost(%q) = %v, want the listing failure", ref, err)
		}
		if !strings.Contains(err.Error(), "500") {
			t.Errorf("resolveCreateHost(%q) = %v, want the status in it", ref, err)
		}
	}
}

// The hint never costs the user the list of hosts that do exist. An org whose
// only host is `amika-cloud` and a user who typed `--host amika` must see
// that hostname, or they take the advice and land on the cloud compute they
// were trying to avoid.
func TestResolveCreateHostHintKeepsTheKnownHostnames(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `[{"id":"host_8","hostname":"amika-cloud","url":"https://box.example",
		  "org_id":"org_1","sizes":{},"created_at":"","updated_at":""}]`)
	}))
	defer srv.Close()

	_, err := resolveCreateHost(apiclient.NewClient(srv.URL, "tok"), "amika")
	if err == nil {
		t.Fatal(`resolveCreateHost("amika"): want an error`)
	}
	if !strings.Contains(err.Error(), "amika-cloud") {
		t.Errorf("err = %v, want the real hostname in it", err)
	}
	if !strings.Contains(err.Error(), "omit --host") {
		t.Errorf("err = %v, want the hint kept too", err)
	}
}

// ...but "cloud" and "amika" are legal hostnames, so an org that registered
// one must still be able to name it. The hint is for a ref that matches
// nothing, not a reserved word.
func TestResolveCreateHostPrefersARealHostOverTheCloudHint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `[{"id":"host_7","hostname":"cloud","url":"https://cloud.example",
		  "org_id":"org_1","sizes":{},"created_at":"","updated_at":""}]`)
	}))
	defer srv.Close()
	client := apiclient.NewClient(srv.URL, "tok")

	id, err := resolveCreateHost(client, "cloud")
	if err != nil || id != "host_7" {
		t.Errorf("exact spelling: got %q, %v", id, err)
	}

	// And a typo in its casing is a typo, not an invitation to drop the flag:
	// hostnames are stored lowercase, so `Cloud` means the host named `cloud`.
	_, err = resolveCreateHost(client, "Cloud")
	if err == nil {
		t.Fatal(`resolveCreateHost("Cloud"): want an error`)
	}
	if strings.Contains(err.Error(), "omit --host") {
		t.Errorf("err = %v, want the no-such-host error naming `cloud`", err)
	}
}

// A control plane that does not know `host_id` strips it — the create schema
// is a plain zod object — and builds the rig on Amika Cloud instead. Saying
// "created" there is the one outcome --host exists to prevent.
func TestAssertRigLandedOnHost(t *testing.T) {
	ref := func(s string) *string { return &s }

	tests := []struct {
		name    string
		sb      apiclient.RemoteSandbox
		hostID  string
		wantErr string
	}{
		{
			name:   "no host asked for",
			sb:     apiclient.RemoteSandbox{Name: "dev", Provider: ref("e2b")},
			hostID: "",
		},
		{
			name:   "landed on the host asked for",
			sb:     apiclient.RemoteSandbox{Name: "dev", HostID: ref("host_1")},
			hostID: "host_1",
		},
		{
			name:    "host_id dropped by the control plane",
			sb:      apiclient.RemoteSandbox{Name: "dev", Provider: ref("e2b")},
			hostID:  "host_1",
			wantErr: "Amika Cloud (provider e2b)",
		},
		{
			name:    "landed on a different host",
			sb:      apiclient.RemoteSandbox{Name: "dev", HostID: ref("host_2")},
			hostID:  "host_1",
			wantErr: "host host_2",
		},
		{
			name:    "host_id dropped and no provider reported",
			sb:      apiclient.RemoteSandbox{Name: "dev"},
			hostID:  "host_1",
			wantErr: "Amika Cloud.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := assertRigLandedOnHost(&tt.sb, tt.hostID)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatal("want an error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %v, want %q in it", err, tt.wantErr)
			}
			// The rig exists; the operator has to be told how to be rid of it.
			if !strings.Contains(err.Error(), "amika rig delete dev") {
				t.Errorf("err = %v, want the cleanup command", err)
			}
			// A control plane reporting some other host id plainly knows the
			// field, so the "old version" diagnosis belongs only to the
			// branch where it went missing.
			oldVersion := strings.Contains(err.Error(), "does not support --host")
			if wantOldVersion := tt.sb.HostID == nil; oldVersion != wantOldVersion {
				t.Errorf("err = %v, old-version diagnosis = %v, want %v", err, oldVersion, wantOldVersion)
			}
		})
	}
}

// newCreateCmd builds a command carrying every flag createRemoteSandbox
// reads, so the whole create path can be driven without the root command.
func newCreateCmd(t *testing.T) (*cobra.Command, *bytes.Buffer) {
	t.Helper()
	c := &cobra.Command{}
	for _, name := range []string{
		"name", "provider", "preset", "size", "snapshot", "setup-script",
		"branch", "new-branch", "github-auth-mode", "host",
	} {
		c.Flags().String(name, "", "")
	}
	for _, name := range []string{
		"secret", "env", "agent-credential", "agent-credential-type",
		"no-agent-credential",
	} {
		c.Flags().StringArray(name, nil, "")
	}
	c.Flags().Bool("no-setup", false, "")
	c.Flags().Bool("connect", false, "")
	c.Flags().String(output.FlagName, "text", "")
	var buf bytes.Buffer
	c.SetOut(&buf)
	return c, &buf
}

// stubCreateAPI serves the one host plus a create and its poll. honorHost
// false models a control plane that does not know `host_id`: the create
// schema is a plain zod object, so it strips the field and builds the rig on
// Amika Cloud instead of refusing. It records the create body.
func stubCreateAPI(t *testing.T, honorHost bool) *map[string]any {
	t.Helper()
	var createBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v0beta1/hosts":
			io.WriteString(w, `[{"id":"host_1","hostname":"alpha.lan","url":"https://a.example",
			  "org_id":"org_1","sizes":{},"created_at":"","updated_at":""}]`)
		case r.Method == "POST" && r.URL.Path == "/api/v0beta1/sandboxes":
			json.NewDecoder(r.Body).Decode(&createBody)
			io.WriteString(w, `{"name":"dev","state":"initializing"}`)
		default:
			if honorHost {
				io.WriteString(w, `{"name":"dev","state":"active","host_id":"host_1"}`)
				return
			}
			io.WriteString(w, `{"name":"dev","state":"active","provider":"e2b"}`)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")
	return &createBody
}

// The flag has to reach the wire. Nothing else in this package exercises the
// plumbing from --host through to the request body.
func TestCreateRemoteSandboxSendsHostID(t *testing.T) {
	body := stubCreateAPI(t, true)
	c, _ := newCreateCmd(t)
	c.Flags().Set("name", "dev")
	c.Flags().Set("host", "alpha.lan")
	c.Flags().Set("size", "small")

	if err := createRemoteSandbox(c, "", gitrepo.Identity{Source: gitrepo.SourceNone}); err != nil {
		t.Fatalf("createRemoteSandbox: %v", err)
	}
	if got := (*body)["host_id"]; got != "host_1" {
		t.Errorf("host_id = %v, want host_1 (body: %v)", got, *body)
	}
	// A host rig takes neither of these, and the API refuses both with host_id.
	for _, forbidden := range []string{"provider", "snapshot"} {
		if _, ok := (*body)[forbidden]; ok {
			t.Errorf("body carries %q: %v", forbidden, *body)
		}
	}
}

// And the landing check has to be wired into the create, not merely exist:
// without the call site, a control plane that strips host_id reports success
// for a rig on Amika Cloud.
func TestCreateRemoteSandboxFailsWhenTheHostWasIgnored(t *testing.T) {
	stubCreateAPI(t, false)
	c, _ := newCreateCmd(t)
	c.Flags().Set("name", "dev")
	c.Flags().Set("host", "alpha.lan")

	err := createRemoteSandbox(c, "", gitrepo.Identity{Source: gitrepo.SourceNone})
	if err == nil {
		t.Fatal("want an error for a rig that did not land on the host")
	}
	for _, want := range []string{"not on the host you asked for", "Amika Cloud", "amika rig delete dev"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %v, want %q in it", err, want)
		}
	}
}
