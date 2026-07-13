package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
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
