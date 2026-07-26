package apiclient

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSandboxSnapshotRequestPaths(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantPath   string
	}{
		{
			name: "ListSandboxSnapshots with both filters",
			call: func(c *Client) error {
				_, err := c.ListSandboxSnapshots("repo1", "sb1")
				return err
			},
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/sandbox-snapshots?repository_id=repo1&source_sandbox_id=sb1",
		},
		{
			name: "ListSandboxSnapshots with no filters",
			call: func(c *Client) error {
				_, err := c.ListSandboxSnapshots("", "")
				return err
			},
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/sandbox-snapshots",
		},
		{
			name: "CreateSandboxSnapshot",
			call: func(c *Client) error {
				_, err := c.CreateSandboxSnapshot(CreateSandboxSnapshotRequest{
					SandboxRef: "my-box",
					Name:       "snap",
					Mode:       "scrub_and_delete",
				})
				return err
			},
			wantMethod: "POST",
			wantPath:   "/api/v0beta1/sandbox-snapshots",
		},
		{
			name: "GetSandboxScrubPreview forwards ref via sandbox+by",
			call: func(c *Client) error {
				_, err := c.GetSandboxScrubPreview("my-box")
				return err
			},
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/sandbox-snapshots/scrub-preview?by=ref&sandbox=my-box",
		},
		{
			name:       "DeleteSandboxSnapshot escapes the reference",
			call:       func(c *Client) error { return c.DeleteSandboxSnapshot("org/snap") },
			wantMethod: "DELETE",
			wantPath:   "/api/v0beta1/sandbox-snapshots/org%2Fsnap?by=ref",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.RequestURI
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]any{"snapshot": "s", "state": "capturing"})
			}))
			defer srv.Close()

			c := NewClient(srv.URL, "test-token")
			if err := tt.call(c); err != nil {
				t.Fatalf("call: %v", err)
			}
			if gotMethod != tt.wantMethod {
				t.Errorf("method = %q, want %q", gotMethod, tt.wantMethod)
			}
			if gotPath != tt.wantPath {
				t.Errorf("path = %q, want %q", gotPath, tt.wantPath)
			}
		})
	}
}

func TestListSandboxSnapshotsParsesEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{"snapshot": "org/snap-a", "provider": "daytona", "state": "active"},
				{"snapshot": "org/snap-b", "provider": "freestyle", "state": "capturing"},
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	items, err := c.ListSandboxSnapshots("", "")
	if err != nil {
		t.Fatalf("ListSandboxSnapshots: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if items[0].Snapshot != "org/snap-a" || items[0].State != "active" {
		t.Errorf("items[0] = %+v", items[0])
	}
}

// TestSandboxSnapshotParsesFullSchema guards the field names the server uses
// for the SandboxSnapshot schema, including the fields added to mirror the
// API precisely (id, repository_url, capture_mode, daytona).
func TestSandboxSnapshotParsesFullSchema(t *testing.T) {
	const body = `{
      "id": "snap_1",
      "snapshot": "org/snap",
      "provider": "daytona",
      "description": "a description",
      "source_sandbox_id": "sb_1",
      "source_sandbox_name": "box",
      "repository_id": "repo_1",
      "repository_url": "https://github.com/org/repo",
      "base_snapshot": null,
      "sandbox_preset": "coder",
      "sandbox_size": "medium",
      "capture_mode": "full",
      "state": "active",
      "error_message": null,
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z",
      "daytona": {"name": "snap-daytona", "state": "active", "cpu": 2}
    }`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, body)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	snap, err := c.GetSandboxSnapshot("snap_1")
	if err != nil {
		t.Fatalf("GetSandboxSnapshot: %v", err)
	}
	if snap.ID != "snap_1" {
		t.Errorf("ID = %q, want snap_1", snap.ID)
	}
	if snap.RepositoryURL == nil || *snap.RepositoryURL != "https://github.com/org/repo" {
		t.Errorf("RepositoryURL = %v", snap.RepositoryURL)
	}
	if snap.CaptureMode == nil || *snap.CaptureMode != "full" {
		t.Errorf("CaptureMode = %v", snap.CaptureMode)
	}
	if snap.Daytona == nil || snap.Daytona.Name != "snap-daytona" || snap.Daytona.CPU != 2 {
		t.Errorf("Daytona = %+v", snap.Daytona)
	}
	if snap.BaseSnapshot != nil {
		t.Errorf("BaseSnapshot = %v, want nil", snap.BaseSnapshot)
	}
}

// TestGetSandboxSnapshot_UsesRefQuery checks the request shape (path +
// by=ref query) used to resolve a snapshot by name or id, matching
// DeleteSandboxSnapshot's convention.
func TestGetSandboxSnapshot_UsesRefQuery(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.RequestURI
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": "snap_1", "snapshot": "s", "state": "active"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	if _, err := c.GetSandboxSnapshot("org/snap"); err != nil {
		t.Fatalf("GetSandboxSnapshot: %v", err)
	}
	if gotMethod != "GET" {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if gotPath != "/api/v0beta1/sandbox-snapshots/org%2Fsnap?by=ref" {
		t.Errorf("path = %q", gotPath)
	}
}

// TestWaitForSandboxSnapshot_PollsUntilTerminal checks that polling continues
// through non-terminal states and stops at "active".
func TestWaitForSandboxSnapshot_PollsUntilTerminal(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		state := "capturing"
		if calls >= 3 {
			state = "active"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": "snap_1", "snapshot": "s", "state": state})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	snap, err := c.WaitForSandboxSnapshot("snap_1")
	if err != nil {
		t.Fatalf("WaitForSandboxSnapshot: %v", err)
	}
	if snap.State != "active" {
		t.Errorf("State = %q, want active", snap.State)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3 (polled through 2 non-terminal states)", calls)
	}
}

// TestWaitForSandboxSnapshot_FailedReturnsErrorMessage checks that a
// terminal "failed" state surfaces the snapshot's error_message.
func TestWaitForSandboxSnapshot_FailedReturnsErrorMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": "snap_1", "snapshot": "s", "state": "failed", "error_message": "capture failed: disk full",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	_, err := c.WaitForSandboxSnapshot("snap_1")
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("expected error mentioning the snapshot's error_message, got %v", err)
	}
}

func TestGetSandboxScrubPreviewParsesResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"files":    []string{"/home/amika/.claude/.credentials.json"},
			"env_vars": []string{"ANTHROPIC_API_KEY"},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	preview, err := c.GetSandboxScrubPreview("my-box")
	if err != nil {
		t.Fatalf("GetSandboxScrubPreview: %v", err)
	}
	if len(preview.Files) != 1 || preview.Files[0] != "/home/amika/.claude/.credentials.json" {
		t.Errorf("Files = %v", preview.Files)
	}
	if len(preview.EnvVars) != 1 || preview.EnvVars[0] != "ANTHROPIC_API_KEY" {
		t.Errorf("EnvVars = %v", preview.EnvVars)
	}
}
