package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

func TestRepoBasename(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"https://github.com/org/repo.git", "repo"},
		{"https://github.com/org/repo", "repo"},
		{"git@github.com:org/repo.git", "repo"},
		{"/local/path/to/repo/", "repo"},
		{"repo", "repo"},
	}
	for _, tt := range tests {
		if got := repoBasename(tt.in); got != tt.want {
			t.Errorf("repoBasename(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestSnapshotSourceAndDeref(t *testing.T) {
	name := "my-box"
	id := "sb-123"
	if got := snapshotSource(apiclient.SandboxSnapshot{SourceSandboxName: &name, SourceSandboxID: &id}); got != "my-box" {
		t.Errorf("prefers name: got %q", got)
	}
	if got := snapshotSource(apiclient.SandboxSnapshot{SourceSandboxID: &id}); got != "sb-123" {
		t.Errorf("falls back to id: got %q", got)
	}
	if got := snapshotSource(apiclient.SandboxSnapshot{}); got != "-" {
		t.Errorf("empty source: got %q", got)
	}
	if deref(nil) != "-" {
		t.Error("deref(nil) should be -")
	}
	if deref(&name) != "my-box" {
		t.Error("deref(&name) should be my-box")
	}
}

// newTestListCmd builds a command carrying the list flags so RunE can be
// exercised directly.
func newTestListCmd() *cobra.Command {
	c := &cobra.Command{RunE: runSnapshotList}
	c.Flags().BoolP("long", "l", false, "")
	c.Flags().String("rig", "", "")
	c.Flags().String("repo", "", "")
	c.Flags().String(output.FlagName, "text", "")
	return c
}

// TestSnapshotListRigFilter checks that snapshot list makes one request,
// handing --rig to the server as the source filter its reference kind names,
// with no client-side lookup of the rig.
func TestSnapshotListRigFilter(t *testing.T) {
	for _, tc := range []struct {
		rig       string
		wantQuery string
	}{
		{rig: "alpha", wantQuery: "source_sandbox_ref=alpha"},
		{rig: "id=sb-1", wantQuery: "source_sandbox_id=sb-1"},
	} {
		t.Run(tc.rig, func(t *testing.T) {
			var queries []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/v0beta1/sandbox-snapshots" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
					return
				}
				queries = append(queries, r.URL.RawQuery)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"items":[]}`))
			}))
			defer srv.Close()
			t.Setenv("AMIKA_API_URL", srv.URL)
			t.Setenv("AMIKA_API_KEY", "test-token")

			c := newTestListCmd()
			c.Flags().Set("rig", tc.rig)
			c.SetOut(&bytes.Buffer{})
			if err := runSnapshotList(c, nil); err != nil {
				t.Fatalf("runSnapshotList: %v", err)
			}
			if len(queries) != 1 || queries[0] != tc.wantQuery {
				t.Fatalf("queries = %q, want [%q]", queries, tc.wantQuery)
			}
		})
	}

	// An unset "$AMIKA_RIG_NAME" must not widen the list to every snapshot.
	t.Run("an explicitly empty --rig fails before any request", func(t *testing.T) {
		t.Setenv("AMIKA_API_URL", "http://127.0.0.1:1")
		c := newTestListCmd()
		c.Flags().Set("rig", "")
		if err := runSnapshotList(c, nil); err == nil || !strings.Contains(err.Error(), "must not be empty") {
			t.Fatalf("err = %v, want the empty-reference error", err)
		}
	})
}

// TestSnapshotCreateRigSelector checks that snapshot create names the source
// rig in the body field its reference kind calls for, and asks the scrub
// preview for the same kind.
func TestSnapshotCreateRigSelector(t *testing.T) {
	var body map[string]any
	var previewQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v0beta1/sandbox-snapshots/scrub-preview":
			previewQuery = r.URL.RawQuery
			_, _ = w.Write([]byte(`{"files":[],"restored_files":[],"env_vars":[]}`))
		case r.Method == "POST" && r.URL.Path == "/api/v0beta1/sandbox-snapshots":
			_ = json.NewDecoder(r.Body).Decode(&body)
			_, _ = w.Write([]byte(`{"id":"snap_1","snapshot":"org/snap","state":"capturing"}`))
		default:
			_, _ = w.Write([]byte(`{"id":"snap_1","snapshot":"org/snap","state":"active"}`))
		}
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")

	c := newTestCreateCmd()
	c.Flags().Set("rig", "id=sb_1")
	c.Flags().Set("name", "snap")
	c.Flags().Set("mode", "scrub_and_delete")
	// Interactive, so the scrub preview is fetched; "y" confirms.
	c.SetIn(strings.NewReader("y\n"))
	c.SetOut(&bytes.Buffer{})
	if err := runSnapshotCreate(c, nil); err != nil {
		t.Fatalf("runSnapshotCreate: %v", err)
	}
	if want := map[string]any{"sandbox_id": "sb_1", "name": "snap", "mode": "scrub_and_delete"}; !reflect.DeepEqual(body, want) {
		t.Fatalf("body = %v, want %v", body, want)
	}
	if want := "by=id&sandbox=sb_1"; previewQuery != want {
		t.Fatalf("scrub preview query = %q, want %q", previewQuery, want)
	}
}

func TestResolveRepositoryID(t *testing.T) {
	repos := []map[string]any{
		{"id": "repo-1", "repo_url": "https://github.com/org/alpha.git"},
		{"id": "repo-2", "repo_url": "https://github.com/org/beta.git"},
		{"id": "repo-3", "repo_url": "https://gitlab.com/other/beta.git"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(repos)
	}))
	defer srv.Close()
	client := apiclient.NewClient(srv.URL, "tok")

	if id, err := resolveRepositoryID(client, "repo-2"); err != nil || id != "repo-2" {
		t.Errorf("by id: got %q, %v", id, err)
	}
	if id, err := resolveRepositoryID(client, "alpha"); err != nil || id != "repo-1" {
		t.Errorf("by basename: got %q, %v", id, err)
	}
	if id, err := resolveRepositoryID(client, "https://github.com/org/beta.git"); err != nil || id != "repo-2" {
		t.Errorf("by exact url: got %q, %v", id, err)
	}
	if _, err := resolveRepositoryID(client, "beta"); err == nil ||
		!strings.Contains(err.Error(), "multiple") {
		t.Errorf("ambiguous basename should error: %v", err)
	}
	if _, err := resolveRepositoryID(client, "missing"); err == nil {
		t.Error("expected not-found error")
	}
}

// newTestCreateCmd builds a command carrying the create flags so RunE can be
// exercised directly.
func newTestCreateCmd() *cobra.Command {
	c := &cobra.Command{RunE: runSnapshotCreate}
	c.Flags().String("rig", "", "")
	c.Flags().String("name", "", "")
	c.Flags().String("mode", "", "")
	c.Flags().String("description", "", "")
	c.Flags().Bool("no-interactive", false, "")
	c.Flags().String(output.FlagName, "text", "")
	return c
}

func TestSnapshotCreateNoInteractiveValidation(t *testing.T) {
	t.Run("requires rig", func(t *testing.T) {
		c := newTestCreateCmd()
		if err := runSnapshotCreate(c, nil); err == nil ||
			!strings.Contains(err.Error(), "--rig is required") {
			t.Errorf("got %v", err)
		}
	})

	t.Run("requires mode without interactive", func(t *testing.T) {
		c := newTestCreateCmd()
		c.Flags().Set("rig", "box")
		c.Flags().Set("no-interactive", "true")
		if err := runSnapshotCreate(c, nil); err == nil ||
			!strings.Contains(err.Error(), "--mode is required") {
			t.Errorf("got %v", err)
		}
	})

	t.Run("requires name without interactive", func(t *testing.T) {
		c := newTestCreateCmd()
		c.Flags().Set("rig", "box")
		c.Flags().Set("no-interactive", "true")
		c.Flags().Set("mode", "full")
		if err := runSnapshotCreate(c, nil); err == nil ||
			!strings.Contains(err.Error(), "--name is required") {
			t.Errorf("got %v", err)
		}
	})
}

// TestSnapshotCreateJSON_PollsUntilTerminalAndEmitsFinalResource guards
// decision 4 of the output-format work: `snapshot create` must poll past the
// create endpoint's 202 "capturing" stub and emit the final polled
// SandboxSnapshot (mirroring the API's schema field-for-field), not the
// in-progress resource returned by POST.
func TestSnapshotCreateJSON_PollsUntilTerminalAndEmitsFinalResource(t *testing.T) {
	var getCalls int
	snapshotBody := func(state string) map[string]any {
		return map[string]any{
			"id": "snap_1", "snapshot": "org/snap", "provider": "daytona",
			"description": nil, "source_sandbox_id": "sb_1", "source_sandbox_name": "box",
			"repository_id": nil, "repository_url": nil, "base_snapshot": nil,
			"sandbox_preset": nil, "sandbox_size": nil, "capture_mode": "full",
			"state": state, "error_message": nil,
			"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
			"daytona": nil,
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/v0beta1/sandbox-snapshots":
			json.NewEncoder(w).Encode(snapshotBody("capturing"))
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/v0beta1/sandbox-snapshots/snap_1"):
			getCalls++
			state := "capturing"
			if getCalls >= 2 {
				state = "active"
			}
			json.NewEncoder(w).Encode(snapshotBody(state))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")

	c := newTestCreateCmd()
	c.Flags().Set("rig", "box")
	c.Flags().Set("name", "snap")
	c.Flags().Set("mode", "full")
	c.Flags().Set("no-interactive", "true")
	c.Flags().Set(output.FlagName, "json")
	var buf bytes.Buffer
	c.SetOut(&buf)

	if err := runSnapshotCreate(c, nil); err != nil {
		t.Fatalf("runSnapshotCreate: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, `"id":"snap_1"`) {
		t.Fatalf("expected the snapshot's id in JSON output, got: %s", out)
	}
	if !strings.Contains(out, `"state":"active"`) {
		t.Fatalf("expected the final polled state (active), not the in-progress stub, got: %s", out)
	}
	if getCalls < 2 {
		t.Fatalf("expected the CLI to poll past the initial capturing state, got %d GET(s)", getCalls)
	}
}

// TestSnapshotListJSON_WrapsItemsEnvelope guards `snapshot list -o json`
// against the API's ListSandboxSnapshotsResponse shape: an object with an
// "items" array, not a bare array like sandbox/secret list.
func TestSnapshotListJSON_WrapsItemsEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v0beta1/sandbox-snapshots" {
			json.NewEncoder(w).Encode(map[string]any{
				"items": []map[string]any{{"id": "snap_1", "snapshot": "org/snap", "provider": "daytona", "state": "active"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")

	c := &cobra.Command{RunE: runSnapshotList}
	c.Flags().BoolP("long", "l", false, "")
	c.Flags().String("rig", "", "")
	c.Flags().String("repo", "", "")
	c.Flags().String(output.FlagName, "text", "")
	c.Flags().Set(output.FlagName, "json")
	var buf bytes.Buffer
	c.SetOut(&buf)

	if err := runSnapshotList(c, nil); err != nil {
		t.Fatalf("runSnapshotList: %v", err)
	}

	var envelope apiclient.ListSandboxSnapshotsResponse
	if err := json.Unmarshal(buf.Bytes(), &envelope); err != nil {
		t.Fatalf("unmarshal: %v\noutput: %s", err, buf.String())
	}
	if len(envelope.Items) != 1 || envelope.Items[0].ID != "snap_1" {
		t.Fatalf("Items = %+v", envelope.Items)
	}
	// Guard the actual wire shape too: a bare array would also unmarshal into
	// a struct with a zero Items field, so check for the "items" key directly.
	if !strings.HasPrefix(strings.TrimSpace(buf.String()), `{"items":`) {
		t.Fatalf("expected an {\"items\":[...]} envelope, got: %s", buf.String())
	}
}
