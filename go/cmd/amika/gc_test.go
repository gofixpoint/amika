package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/ssh"
)

func TestGCCommandForcesCollectionAndHonorsJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	t.Setenv("AMIKA_API_KEY", "gc-test-key")
	body := `[{"id":"sb_1"}]`
	status := http.StatusOK
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Path != "/api/v0beta1/sandboxes" || r.Header.Get("Authorization") != "Bearer gc-test-key" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	paths := basedir.New("")
	if _, err := ssh.UpsertHost(paths, ssh.HostEntry{SandboxID: "sb_1", HostName: "example.test"}); err != nil {
		t.Fatal(err)
	}
	// The first run establishes ownership for an old entry. The second must
	// bypass both the size threshold and cooldown despite running immediately.
	for i, format := range []string{"json", "json-pretty"} {
		if i == 1 {
			body = `[]`
		}
		out, err := runRootCommandOutput(t, "gc", "-o", format)
		if err != nil {
			t.Fatalf("gc: %v\n%s", err, out)
		}
		var result ssh.GCResult
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatalf("stdout is not JSON: %s", out)
		}
		if !result.Collected || result.Removed != i || result.Remaining != 1-i {
			t.Fatalf("result = %+v", result)
		}
	}
	if calls != 2 {
		t.Fatalf("requests = %d", calls)
	}
	configPath, _ := paths.SSHAmikaConfigFile()
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "amika-sb_1") {
		t.Fatalf("config still contains deleted host: %s", data)
	}
	status, body = http.StatusUnauthorized, `{"error":"unauthorized"}`
	if _, err := runRootCommandOutput(t, "gc"); err == nil {
		t.Fatal("explicit gc hid API failure")
	}
}

func TestGCRejectsArguments(t *testing.T) {
	if _, err := runRootCommandOutput(t, "gc", "unexpected"); err == nil {
		t.Fatal("gc accepted an argument")
	}
}
