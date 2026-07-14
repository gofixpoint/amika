package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
