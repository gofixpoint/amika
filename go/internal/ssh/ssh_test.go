package ssh

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

func TestRunSSHStreamsOutput(t *testing.T) {
	binDir := t.TempDir()
	sshPath := filepath.Join(binDir, "ssh")
	script := "#!/bin/sh\nfor arg in \"$@\"; do case \"$arg\" in echo*) eval \"$arg\" ;; esac; done\n"
	if err := os.WriteFile(sshPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/ssh") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ssh_destination":"example.com","token":"tok","expires_at":"2099-01-01T00:00:00Z"}`))
	}))
	t.Cleanup(server.Close)

	client := apiclient.NewClient(server.URL, "test-token")
	var stdout bytes.Buffer
	if err := RunSSH(client, "sb-1", []string{"echo hello"}, nil, &stdout, io.Discard); err != nil {
		t.Fatalf("RunSSH() error: %v", err)
	}
	if got := strings.TrimSpace(stdout.String()); got != "hello" {
		t.Fatalf("stdout = %q, want %q", got, "hello")
	}
}
