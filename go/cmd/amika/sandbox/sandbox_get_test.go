package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

func newSandboxGetTestRoot() *cobra.Command {
	root := &cobra.Command{Use: "amika", SilenceUsage: true, SilenceErrors: true}
	output.AddFlag(root)
	rig := &cobra.Command{Use: "rig"}
	rig.AddCommand(&cobra.Command{
		Use:  "get <rig-ref>",
		Args: cobra.ExactArgs(1),
		RunE: runSandboxGet,
	})
	root.AddCommand(rig)
	return root
}

func TestSandboxGetOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.RequestURI != "/api/v0beta1/sandboxes/org%2Fbox" {
			t.Errorf("request = %s %s", r.Method, r.RequestURI)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"sb_1","name":"box","org_id":"org_1","hostname":"box.r.acme.o.amika.test","host_id":"host_1","status":"running","has_workflow":false,"secret_names":[],"mounted_secrets":[],"resolved_agent_credentials":[],"agent_credentials":[],"services":[{"name":"web","url":"https://web.example.test","hostPort":3000,"containerPort":3000,"protocol":"tcp","kind":"user"}],"created_at":"2026-09-30T00:00:00Z","updated_at":"2026-09-30T01:00:00Z"}`))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")
	// The alias is <name>.<id>.<control-plane slug>.amika, where the slug is
	// the API URL's host and port with every separator folded to a dash.
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	wantSSHHost := "box.sb_1." + strings.NewReplacer(".", "-", ":", "-").Replace(parsed.Host) + ".amika"

	for _, format := range []string{"text", "json", "json-pretty"} {
		t.Run(format, func(t *testing.T) {
			root := newSandboxGetTestRoot()
			var out bytes.Buffer
			root.SetOut(&out)
			root.SetErr(&bytes.Buffer{})
			root.SetArgs([]string{"rig", "get", "org/box", "--output", format})
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(out.String(), "has_workflow") {
				t.Errorf("output includes removed field has_workflow: %s", out.String())
			}
			if format == "text" {
				for _, want := range []string{
					"id: sb_1\n", "name: box\n", "hostname: box.r.acme.o.amika.test\n",
					"ssh_host: " + wantSSHHost + "\n",
					"host_id: host_1\n",
					"secret_names: []\n", "mounted_secrets: []\n",
					"resolved_agent_credentials: []\n", "agent_credentials: []\n",
					"services[0].name: web\n", "services[0].kind: user\n",
				} {
					if !strings.Contains(out.String(), want) {
						t.Errorf("text output missing %q:\n%s", want, out.String())
					}
				}
				return
			}
			var got map[string]any
			if err := json.Unmarshal(out.Bytes(), &got); err != nil {
				t.Fatalf("decode JSON: %v\n%s", err, out.String())
			}
			if got["name"] != "box" || got["hostname"] != "box.r.acme.o.amika.test" || got["host_id"] != "host_1" {
				t.Errorf("unexpected JSON: %s", out.String())
			}
			if got["ssh_host"] != wantSSHHost {
				t.Errorf("ssh_host = %v, want %q", got["ssh_host"], wantSSHHost)
			}
			for _, key := range []string{"secret_names", "mounted_secrets", "resolved_agent_credentials", "agent_credentials"} {
				if items, ok := got[key].([]any); !ok || len(items) != 0 {
					t.Errorf("%s: [] lost in JSON: %s", key, out.String())
				}
			}
			services, ok := got["services"].([]any)
			if !ok || len(services) != 1 || services[0].(map[string]any)["kind"] != "user" {
				t.Errorf("services lost in JSON: %s", out.String())
			}
		})
	}
}

func TestWriteSandboxGetTextMissingHostnameAndEmptyServices(t *testing.T) {
	var out bytes.Buffer
	if err := writeSandboxGetText(&out, sandboxGetResult{RemoteSandbox: apiclient.RemoteSandbox{
		ID:       "sb_1",
		Name:     "box",
		Services: []apiclient.RemoteSandboxService{},
	}}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"hostname: -\n", "ssh_host: -\n", "services: []\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("text output missing %q:\n%s", want, out.String())
		}
	}
}

func TestWriteSandboxGetTextNestedFieldsAndLineBreaks(t *testing.T) {
	message := "setup failed\nretry from C:\\repo\r"
	var out bytes.Buffer
	if err := writeSandboxGetText(&out, sandboxGetResult{RemoteSandbox: apiclient.RemoteSandbox{
		ErrorMessage:      &message,
		SandboxSizeConfig: json.RawMessage(`{"name":"m","vcpus":4,"memoryGib":8,"diskGib":20,"diskGrowOnly":false}`),
		AgentCredentials:  json.RawMessage(`[{"kind":"codex","name":null,"scope":null,"credential_type":null,"inject_target":null}]`),
	}}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`error_message: setup failed\nretry from C:\\repo\r`,
		"sandbox_size_config.vcpus: 4",
		"sandbox_size_config.diskGrowOnly: false",
		"agent_credentials[0].kind: codex",
		"agent_credentials[0].name: -",
	} {
		if !strings.Contains(out.String(), want+"\n") {
			t.Errorf("text output missing %q:\n%s", want, out.String())
		}
	}
}

func TestSandboxGetMissingRig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"code":"not_found"}`, http.StatusNotFound)
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	root := newSandboxGetTestRoot()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"rig", "get", "missing", "-o", "json"})
	if err := root.Execute(); err == nil {
		t.Fatal("missing rig should fail")
	}
	if out.Len() != 0 {
		t.Fatalf("failed get wrote stdout: %s", out.String())
	}
}

func TestSandboxSSHHostNilForUnaliasableName(t *testing.T) {
	if got := sandboxSSHHost(apiclient.RemoteSandbox{ID: "sb_1", Name: "has space"}); got != nil {
		t.Errorf("sandboxSSHHost = %q, want nil", *got)
	}
}

func TestSandboxGetSelf(t *testing.T) {
	var requested []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.RequestURI)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"sb_1","name":"here","org_id":"org_1","status":"running","secret_names":[],"mounted_secrets":[],"resolved_agent_credentials":[],"agent_credentials":[],"services":[],"created_at":"2026-09-30T00:00:00Z","updated_at":"2026-09-30T01:00:00Z"}`))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	run := func() error {
		root := newSandboxGetTestRoot()
		root.SetOut(&bytes.Buffer{})
		root.SetErr(&bytes.Buffer{})
		root.SetArgs([]string{"rig", "get", "_self"})
		return root.Execute()
	}

	t.Setenv("AMIKA_RIG_NAME", "here")
	t.Setenv("AMIKA_SANDBOX_NAME", "legacy")
	if err := run(); err != nil {
		t.Fatal(err)
	}
	if len(requested) != 1 || requested[0] != "/api/v0beta1/sandboxes/here" {
		t.Fatalf("requests = %v, want one for the AMIKA_RIG_NAME rig", requested)
	}

	requested = nil
	t.Setenv("AMIKA_RIG_NAME", "")
	t.Setenv("AMIKA_SANDBOX_NAME", "")
	if err := run(); err == nil || !strings.Contains(err.Error(), "AMIKA_RIG_NAME") {
		t.Fatalf("_self outside a rig error = %v, want one naming AMIKA_RIG_NAME", err)
	}
	if len(requested) != 0 {
		t.Fatalf("_self outside a rig made requests %v, want none", requested)
	}
}
