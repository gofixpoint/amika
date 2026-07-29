package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/sandbox"
)

// resetServiceFlags clears flag state that cobra otherwise carries across
// Execute calls on the shared command objects, so each test starts from the
// command's declared defaults regardless of test order.
func resetServiceFlags(t *testing.T) {
	t.Helper()
	if err := serviceCmd.PersistentFlags().Set("local", "false"); err != nil {
		t.Fatal(err)
	}
	if err := serviceCmd.PersistentFlags().Set("remote", "false"); err != nil {
		t.Fatal(err)
	}
	if err := serviceCmd.PersistentFlags().Set("remote-target", ""); err != nil {
		t.Fatal(err)
	}
	if err := serviceListCmd.Flags().Set("sandbox-name", ""); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"sandbox", "name", "url-scheme"} {
		if err := serviceCreateCmd.Flags().Set(f, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := serviceCreateCmd.Flags().Set("port", "0"); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"sandbox", "name"} {
		if err := serviceDeleteCmd.Flags().Set(f, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := serviceDeleteCmd.Flags().Set("force", "false"); err != nil {
		t.Fatal(err)
	}
}

func TestServiceListCommand_Local_PrintsRows(t *testing.T) {
	resetServiceFlags(t)
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(sandbox.Info{
		Name:      "sb-a",
		Provider:  "docker",
		Image:     "img",
		CreatedAt: "now",
		Services: []sandbox.ServiceInfo{
			{
				Name: "frontend",
				Ports: []sandbox.ServicePortInfo{
					{
						PortBinding: sandbox.PortBinding{HostIP: "127.0.0.1", HostDomain: "localhost", HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"},
						URL:         "http://localhost:3000",
					},
				},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	out, err := runRootCommand("service", "list", "--local")
	if err != nil {
		t.Fatalf("service list --local failed: %v", err)
	}
	for _, needle := range []string{"SERVICE", "SANDBOX", "PORTS", "URL", "frontend", "sb-a", "127.0.0.1:3000->3000/tcp", "http://localhost:3000"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("output missing %q:\n%s", needle, out)
		}
	}
}

func TestServiceListCommand_Local_SandboxNameFilter(t *testing.T) {
	resetServiceFlags(t)
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	svc := []sandbox.ServiceInfo{{Name: "frontend", Ports: []sandbox.ServicePortInfo{{PortBinding: sandbox.PortBinding{HostIP: "127.0.0.1", HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"}}}}}
	if err := store.Save(sandbox.Info{Name: "keep", Provider: "docker", CreatedAt: "now", Services: svc}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(sandbox.Info{Name: "other", Provider: "docker", CreatedAt: "now", Services: svc}); err != nil {
		t.Fatal(err)
	}

	out, err := runRootCommand("service", "list", "--local", "--sandbox-name", "keep")
	if err != nil {
		t.Fatalf("service list failed: %v", err)
	}
	if !strings.Contains(out, "keep") {
		t.Fatalf("output missing target sandbox:\n%s", out)
	}
	if strings.Contains(out, "other") {
		t.Fatalf("--sandbox-name filter leaked another sandbox:\n%s", out)
	}
}

func TestServiceListCommand_Local_NoServices(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	out, err := runRootCommand("service", "list", "--local")
	if err != nil {
		t.Fatalf("service list failed: %v", err)
	}
	if !strings.Contains(out, "No services found.") {
		t.Fatalf("expected empty message, got:\n%s", out)
	}
}

// --remote-target is unsupported and must be rejected up front regardless of
// mode, matching the sandbox command — not silently ignored in local mode.
func TestServiceListCommand_RemoteTargetRejected(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	_, err := runRootCommand("service", "list", "--local", "--remote-target", "staging")
	if err == nil {
		t.Fatal("expected --remote-target to be rejected")
	}
	if !strings.Contains(err.Error(), "not yet supported") {
		t.Fatalf("expected 'not yet supported' error, got: %v", err)
	}
}

// The default mode is remote, so listing without credentials must fail with a
// login hint rather than silently reading local state.
func TestServiceListCommand_DefaultRemote_RequiresAuth(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	_, err := runRootCommand("service", "list")
	if err == nil {
		t.Fatal("expected an auth error in remote mode without credentials")
	}
	if !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("expected 'not logged in' error, got: %v", err)
	}
}

func TestValidateServiceName(t *testing.T) {
	valid := []string{"web", "a", "web-1", "0", "my-service-name", strings.Repeat("a", 63)}
	for _, n := range valid {
		if err := validateServiceName(n); err != nil {
			t.Errorf("validateServiceName(%q) = %v, want nil", n, err)
		}
	}
	invalid := []string{"", "Web", "web_1", "-web", "web-", "web.api", "a b", strings.Repeat("a", 64)}
	for _, n := range invalid {
		if err := validateServiceName(n); err == nil {
			t.Errorf("validateServiceName(%q) = nil, want error", n)
		}
	}
}

// The create command validates its inputs client-side before any network call,
// so these cases fail without a server.
func TestServiceCreateCommand_Validation(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"missing sandbox", []string{"service", "create", "--name", "web", "--port", "3000", "--url-scheme", "https"}, "--sandbox is required"},
		{"missing name", []string{"service", "create", "--sandbox", "box", "--port", "3000", "--url-scheme", "https"}, "--name is required"},
		{"missing port", []string{"service", "create", "--sandbox", "box", "--name", "web", "--url-scheme", "https"}, "--port is required"},
		{"missing url-scheme", []string{"service", "create", "--sandbox", "box", "--name", "web", "--port", "3000"}, "--url-scheme is required"},
		{"bad name", []string{"service", "create", "--sandbox", "box", "--name", "Web_1", "--port", "3000", "--url-scheme", "https"}, "must be a single DNS label"},
		{"bad url-scheme", []string{"service", "create", "--sandbox", "box", "--name", "web", "--port", "3000", "--url-scheme", "ftp"}, `must be "http" or "https"`},
		{"port too large", []string{"service", "create", "--sandbox", "box", "--name", "web", "--port", "70000", "--url-scheme", "https"}, "must be between 1 and 65535"},
		{"reserved port low", []string{"service", "create", "--sandbox", "box", "--name", "web", "--port", "60899", "--url-scheme", "https"}, "reserved for internal Amika services"},
		{"reserved port high", []string{"service", "create", "--sandbox", "box", "--name", "web", "--port", "60999", "--url-scheme", "https"}, "reserved for internal Amika services"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetServiceFlags(t)
			_, err := runRootCommand(tc.args...)
			if err == nil {
				t.Fatalf("expected error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestServiceDeleteCommand_Validation(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"missing sandbox", []string{"service", "delete", "--force", "--name", "web"}, "--sandbox is required"},
		{"missing name", []string{"service", "delete", "--force", "--sandbox", "box"}, "--name is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetServiceFlags(t)
			_, err := runRootCommand(tc.args...)
			if err == nil {
				t.Fatalf("expected error containing %q", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}

// Declining the confirmation prompt aborts without deleting (no network call).
// A credential is provided so the default remote mode passes the auth check and
// reaches the prompt.
func TestServiceDeleteCommand_DeclineAborts(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")
	rootCmd.SetIn(strings.NewReader("n\n"))
	defer rootCmd.SetIn(nil)

	out, err := runRootCommand("service", "delete", "--sandbox", "box", "--name", "web")
	if err != nil {
		t.Fatalf("delete declined should not error: %v", err)
	}
	if !strings.Contains(out, "Aborted.") {
		t.Fatalf("expected 'Aborted.', got:\n%s", out)
	}
}

// The delete alias `rm` resolves to the same command.
func TestServiceDeleteCommand_RmAlias(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")
	rootCmd.SetIn(strings.NewReader("n\n"))
	defer rootCmd.SetIn(nil)

	out, err := runRootCommand("service", "rm", "--sandbox", "box", "--name", "web")
	if err != nil {
		t.Fatalf("service rm should resolve: %v", err)
	}
	if !strings.Contains(out, "Aborted.") {
		t.Fatalf("expected 'Aborted.', got:\n%s", out)
	}
}

// create and delete are remote-only: --local must be rejected rather than
// silently routed to the remote API (which would mutate the wrong service when
// a same-named local and remote sandbox coexist).
func TestServiceCreateCommand_LocalRejected(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	_, err := runRootCommand("service", "create", "--local", "--sandbox", "box", "--name", "web", "--port", "3000", "--url-scheme", "https")
	if err == nil {
		t.Fatal("expected --local to be rejected for create")
	}
	if !strings.Contains(err.Error(), "only supported for remote sandboxes") {
		t.Fatalf("expected remote-only error, got: %v", err)
	}
}

func TestServiceDeleteCommand_LocalRejected(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	_, err := runRootCommand("service", "delete", "--local", "--force", "--sandbox", "box", "--name", "web")
	if err == nil {
		t.Fatal("expected --local to be rejected for delete")
	}
	if !strings.Contains(err.Error(), "only supported for remote sandboxes") {
		t.Fatalf("expected remote-only error, got: %v", err)
	}
}

// --remote-target is unsupported and must be rejected up front for the mutating
// commands too, not silently ignored.
func TestServiceCreateCommand_RemoteTargetRejected(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	_, err := runRootCommand("service", "create", "--remote-target", "staging", "--sandbox", "box", "--name", "web", "--port", "3000", "--url-scheme", "https")
	if err == nil {
		t.Fatal("expected --remote-target to be rejected")
	}
	if !strings.Contains(err.Error(), "not yet supported") {
		t.Fatalf("expected 'not yet supported' error, got: %v", err)
	}
}

func TestServiceDeleteCommand_RemoteTargetRejected(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	_, err := runRootCommand("service", "delete", "--remote-target", "staging", "--force", "--sandbox", "box", "--name", "web")
	if err == nil {
		t.Fatal("expected --remote-target to be rejected")
	}
	if !strings.Contains(err.Error(), "not yet supported") {
		t.Fatalf("expected 'not yet supported' error, got: %v", err)
	}
}

// The default mode is remote, so mutating without credentials must fail with a
// login hint rather than silently attempting a request.
func TestServiceDeleteCommand_DefaultRemote_RequiresAuth(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "")

	_, err := runRootCommand("service", "delete", "--force", "--sandbox", "box", "--name", "web")
	if err == nil {
		t.Fatal("expected an auth error in remote mode without credentials")
	}
	if !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("expected 'not logged in' error, got: %v", err)
	}
}

// A successful create prints the returned service as a one-row table. The
// client is pointed at a fake API server via AMIKA_API_URL.
func TestServiceCreateCommand_PrintsCreatedService(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v0beta1/sandboxes/box/services" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		svcURL := "https://web.example.com"
		_ = json.NewEncoder(w).Encode(apiclient.SandboxServiceResource{
			Name:      "web",
			Port:      3000,
			URLScheme: "https",
			URL:       &svcURL,
		})
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)

	out, err := runRootCommand("service", "create", "--sandbox", "box", "--name", "web", "--port", "3000", "--url-scheme", "https")
	if err != nil {
		t.Fatalf("service create failed: %v", err)
	}
	for _, needle := range []string{"NAME", "PORT", "SCHEME", "URL", "web", "3000", "https://web.example.com"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("output missing %q:\n%s", needle, out)
		}
	}
}

// A created service with no provisioned URL renders the URL column as "-",
// matching how `service list` renders a missing URL.
func TestServiceCreateCommand_NoURLRendersDash(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(apiclient.SandboxServiceResource{
			Name:      "web",
			Port:      3000,
			URLScheme: "https",
			URL:       nil,
		})
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)

	out, err := runRootCommand("service", "create", "--sandbox", "box", "--name", "web", "--port", "3000", "--url-scheme", "https")
	if err != nil {
		t.Fatalf("service create failed: %v", err)
	}
	if !strings.Contains(out, "-") {
		t.Fatalf("expected '-' for missing URL, got:\n%s", out)
	}
}

// A successful delete prints the confirmation line after the API call.
func TestServiceDeleteCommand_PrintsDeleted(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/v0beta1/sandboxes/box/services/web" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)

	out, err := runRootCommand("service", "delete", "--force", "--sandbox", "box", "--name", "web")
	if err != nil {
		t.Fatalf("service delete failed: %v", err)
	}
	if !strings.Contains(out, `Service "web" deleted`) {
		t.Fatalf("expected deleted message, got:\n%s", out)
	}
}

// With -o json, create emits the created service as a single JSON object with
// snake_case keys rather than the text table.
func TestServiceCreateCommand_JSONOutput(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		svcURL := "https://web.example.com"
		_ = json.NewEncoder(w).Encode(apiclient.SandboxServiceResource{
			Name:      "web",
			Port:      3000,
			URLScheme: "https",
			URL:       &svcURL,
		})
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)

	out, err := runRootCommandOutput(t, "service", "create", "--sandbox", "box", "--name", "web", "--port", "3000", "--url-scheme", "https", "-o", "json")
	if err != nil {
		t.Fatalf("service create failed: %v", err)
	}
	var got serviceCreateResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	want := serviceCreateResult{Name: "web", Port: 3000, URLScheme: "https", URL: "https://web.example.com"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if strings.Contains(out, "NAME") {
		t.Fatalf("JSON output unexpectedly contains the text table header:\n%s", out)
	}
}

// With -o json --force, delete emits an ItemResult JSON object.
func TestServiceDeleteCommand_JSONOutput(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)

	out, err := runRootCommandOutput(t, "service", "delete", "--force", "--sandbox", "box", "--name", "web", "-o", "json")
	if err != nil {
		t.Fatalf("service delete failed: %v", err)
	}
	var got output.ItemResult
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("output is not valid JSON: %v\n%s", err, out)
	}
	if got.Name != "web" || got.Status != "deleted" {
		t.Fatalf("got %+v, want name=web status=deleted", got)
	}
}

// In JSON mode, delete refuses to prompt and requires --force, so it errors
// before making any request when --force is absent.
func TestServiceDeleteCommand_JSONRequiresForce(t *testing.T) {
	resetServiceFlags(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "test-key")

	_, err := runRootCommandOutput(t, "service", "delete", "--sandbox", "box", "--name", "web", "-o", "json")
	if err == nil {
		t.Fatal("expected an error requiring --force in JSON mode")
	}
	if !strings.Contains(err.Error(), "--force") {
		t.Fatalf("expected error mentioning --force, got: %v", err)
	}
}

func TestFormatRemoteServicePort(t *testing.T) {
	cases := []struct {
		name string
		in   apiclient.RemoteSandboxService
		want string
	}{
		{"equal ports", apiclient.RemoteSandboxService{HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"}, "3000->3000/tcp"},
		{"differing ports", apiclient.RemoteSandboxService{HostPort: 40001, ContainerPort: 3000, Protocol: "tcp"}, "40001->3000/tcp"},
		{"empty protocol defaults tcp", apiclient.RemoteSandboxService{HostPort: 3000, ContainerPort: 3000}, "3000->3000/tcp"},
		{"udp protocol", apiclient.RemoteSandboxService{HostPort: 53, ContainerPort: 53, Protocol: "udp"}, "53->53/udp"},
	}
	for _, tc := range cases {
		if got := formatRemoteServicePort(tc.in); got != tc.want {
			t.Fatalf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestGroupRemoteServices(t *testing.T) {
	rows := groupRemoteServices("sb-a", []apiclient.RemoteSandboxService{
		{Name: "Coding Agent", URL: "https://agent.example.com", HostPort: 4096, ContainerPort: 4096, Protocol: "tcp"},
		{Name: "frontend", URL: "https://fe.example.com", HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"},
		{Name: "frontend", URL: "https://fe-admin.example.com", HostPort: 3001, ContainerPort: 3001, Protocol: "tcp"},
	})

	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2 (grouped by service name)", len(rows))
	}
	if rows[0].service != "Coding Agent" || rows[0].sandboxName != "sb-a" {
		t.Fatalf("unexpected first row: %+v", rows[0])
	}
	if rows[0].ports != "4096->4096/tcp" || rows[0].url != "https://agent.example.com" {
		t.Fatalf("unexpected first row content: %+v", rows[0])
	}
	// The multi-port service collapses into one row with joined ports/URLs.
	if rows[1].service != "frontend" {
		t.Fatalf("unexpected second row: %+v", rows[1])
	}
	if rows[1].ports != "3000->3000/tcp,3001->3001/tcp" {
		t.Fatalf("ports not joined: %q", rows[1].ports)
	}
	if rows[1].url != "https://fe.example.com https://fe-admin.example.com" {
		t.Fatalf("urls not joined: %q", rows[1].url)
	}
}

func TestGroupRemoteServices_NoURL(t *testing.T) {
	rows := groupRemoteServices("sb-a", []apiclient.RemoteSandboxService{
		{Name: "frontend", URL: "", HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"},
	})
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	if rows[0].url != "-" {
		t.Fatalf("missing URL should render as '-', got %q", rows[0].url)
	}
}
