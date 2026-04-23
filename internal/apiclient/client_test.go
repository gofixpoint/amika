package apiclient

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
			name: "AgentSend with slash",
			call: func(c *Client) error {
				_, err := c.AgentSend("a/b", AgentSendRequest{Message: "hi"})
				return err
			},
			wantMethod: "POST",
			wantPath:   "/api/sandboxes/a%2Fb/agent-send",
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

func TestExtractAgentAuthError(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		wantHit bool
	}{
		{
			name:    "non-HTTPError is ignored",
			err:     fmt.Errorf("some other error"),
			wantHit: false,
		},
		{
			name:    "HTTPError without JSON body",
			err:     &HTTPError{StatusCode: 500, Body: "internal server error"},
			wantHit: false,
		},
		{
			name: "HTTPError with auth failure in agent result",
			err: &HTTPError{StatusCode: 500, Body: mustJSON(t, map[string]interface{}{
				"error": "Agent command failed",
				"details": mustJSONString(t, map[string]interface{}{
					"type":     "result",
					"is_error": true,
					"result":   `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}`,
				}),
			})},
			wantHit: true,
		},
		{
			name: "HTTPError with non-auth agent error",
			err: &HTTPError{StatusCode: 500, Body: mustJSON(t, map[string]interface{}{
				"error": "Agent command failed",
				"details": mustJSONString(t, map[string]interface{}{
					"type":     "result",
					"is_error": true,
					"result":   "Some other agent error",
				}),
			})},
			wantHit: false,
		},
		{
			name: "HTTPError with is_error false",
			err: &HTTPError{StatusCode: 500, Body: mustJSON(t, map[string]interface{}{
				"error": "Agent command failed",
				"details": mustJSONString(t, map[string]interface{}{
					"type":     "result",
					"is_error": false,
					"result":   "Failed to authenticate. API Error: 401",
				}),
			})},
			wantHit: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractAgentAuthError(tt.err)
			if tt.wantHit && got == "" {
				t.Error("expected auth error to be detected, got empty string")
			}
			if !tt.wantHit && got != "" {
				t.Errorf("expected no auth error, got %q", got)
			}
		})
	}
}

func TestAgentSendAuthErrorMessage(t *testing.T) {
	details := mustJSONString(t, map[string]interface{}{
		"type":     "result",
		"is_error": true,
		"result":   `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}`,
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "Agent command failed",
			"details": details,
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	_, err := c.AgentSend("test-sandbox", AgentSendRequest{Message: "hello"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	msg := err.Error()
	if !strings.Contains(msg, "failed to authenticate with its AI provider") {
		t.Errorf("error should mention auth provider failure, got: %s", msg)
	}
	if !strings.Contains(msg, "expired or been revoked") { //nolint:dupword
		t.Errorf("error should mention expired credentials, got: %s", msg)
	}
}

func mustJSON(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("mustJSON: %v", err)
	}
	return string(b)
}

func mustJSONString(t *testing.T, v interface{}) string {
	t.Helper()
	return mustJSON(t, v)
}
