package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPathEscapesSandboxName(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantPath   string
	}{
		{
			name:       "GetSandbox with slash",
			call:       func(c *Client) error { _, err := c.GetSandbox("org/proj"); return err },
			wantMethod: "GET",
			wantPath:   "/api/sandboxes/org%2Fproj",
		},
		{
			name:       "DeleteSandbox with slash",
			call:       func(c *Client) error { return c.DeleteSandbox("org/proj") },
			wantMethod: "DELETE",
			wantPath:   "/api/sandboxes/org%2Fproj",
		},
		{
			name:       "StartSandbox with slash",
			call:       func(c *Client) error { return c.StartSandbox("a/b") },
			wantMethod: "POST",
			wantPath:   "/api/sandboxes/a%2Fb/start",
		},
		{
			name:       "StopSandbox with slash",
			call:       func(c *Client) error { return c.StopSandbox("a/b") },
			wantMethod: "POST",
			wantPath:   "/api/sandboxes/a%2Fb/stop",
		},
		{
			name:       "GetSSH with slash",
			call:       func(c *Client) error { _, err := c.GetSSH("a/b"); return err },
			wantMethod: "POST",
			wantPath:   "/api/sandboxes/a%2Fb/ssh",
		},
		{
			name:       "RevokeSSH with slash",
			call:       func(c *Client) error { return c.RevokeSSH("a/b", "tok") },
			wantMethod: "DELETE",
			wantPath:   "/api/sandboxes/a%2Fb/ssh",
		},
		{
			name:       "ListSessions with slash",
			call:       func(c *Client) error { _, err := c.ListSessions("a/b"); return err },
			wantMethod: "GET",
			wantPath:   "/api/sandboxes/a%2Fb/sessions",
		},
		{
			name:       "GetSandbox without slash",
			call:       func(c *Client) error { _, err := c.GetSandbox("simple-name"); return err },
			wantMethod: "GET",
			wantPath:   "/api/sandboxes/simple-name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.RequestURI
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]string{"id": "1", "name": "test", "state": "active"})
			}))
			defer srv.Close()

			c := NewClient(srv.URL, "test-token")
			_ = tt.call(c)

			if gotMethod != tt.wantMethod {
				t.Errorf("method = %q, want %q", gotMethod, tt.wantMethod)
			}
			if gotPath != tt.wantPath {
				t.Errorf("path = %q, want %q", gotPath, tt.wantPath)
			}
		})
	}
}
