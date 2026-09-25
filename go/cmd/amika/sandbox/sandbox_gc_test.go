package sandboxcmd

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

func TestEditorSSHMaintenanceRunsDailyAndOnlyWarnsOnFailure(t *testing.T) {
	paths, _ := testSSHPaths(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	calls, status := 0, http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`[{"id":"sb_1"}]`))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	client := apiclient.NewClient(server.URL, "test-key")
	alias, err := ssh.UpsertHost(paths, ssh.HostEntry{SandboxID: "sb_1"})
	if err != nil {
		t.Fatal(err)
	}
	var warnings bytes.Buffer
	cmd := &cobra.Command{}
	cmd.SetErr(&warnings)
	maintainSSHHosts(cmd, paths, client, alias)
	maintainSSHHosts(cmd, paths, client, alias)
	if calls != 1 || warnings.Len() != 0 {
		t.Fatalf("calls=%d, warnings=%s", calls, &warnings)
	}
	state, err := ssh.LoadState(paths)
	if err != nil {
		t.Fatal(err)
	}
	for scope, metadata := range state.GarbageCollection {
		metadata.LastSuccess = time.Now().Add(-25 * time.Hour)
		metadata.LastAttempt = metadata.LastSuccess
		state.GarbageCollection[scope] = metadata
	}
	if err := ssh.SaveState(paths, state); err != nil {
		t.Fatal(err)
	}
	status = http.StatusServiceUnavailable
	maintainSSHHosts(cmd, paths, client, alias)
	if calls != 2 || warnings.Len() == 0 {
		t.Fatalf("calls=%d, warnings=%s", calls, &warnings)
	}
	state, err = ssh.LoadState(paths)
	if err != nil || len(state.Hosts) != 1 {
		t.Fatalf("maintenance lost target: %+v, %v", state, err)
	}
	warnings.Reset()
	maintainSSHHosts(cmd, paths, client, alias)
	if calls != 2 || warnings.Len() != 0 {
		t.Fatal("failed maintenance did not back off")
	}
}

func TestEditorClientPinsCredentialAcrossLoginChanges(t *testing.T) {
	t.Setenv("AMIKA_API_KEY", "initial-key")
	client, err := getEditorClient("")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMIKA_API_KEY", "different-account-key")
	token, err := client.TokenSource.Token()
	if err != nil || token != "initial-key" {
		t.Fatal("editor client changed credentials between target resolution and GC")
	}
}
