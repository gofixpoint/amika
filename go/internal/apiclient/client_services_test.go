package apiclient

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSandboxServiceRequestPaths(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantPath   string
	}{
		{
			name: "CreateSandboxService escapes the sandbox ref",
			call: func(c *Client) error {
				_, err := c.CreateSandboxService(SandboxByRef("org/box"), SandboxServiceRequest{Name: "web", Port: 3000, URLScheme: "https"})
				return err
			},
			wantMethod: "POST",
			wantPath:   "/api/v0beta1/sandboxes/org%2Fbox/services",
		},
		{
			name: "PutSandboxService defaults by=name and escapes refs",
			call: func(c *Client) error {
				_, err := c.PutSandboxService(SandboxByRef("my-box"), "web", "", SandboxServiceRequest{Name: "web", Port: 8080, URLScheme: "http"})
				return err
			},
			wantMethod: "PUT",
			wantPath:   "/api/v0beta1/sandboxes/my-box/services/web?by=name",
		},
		{
			name: "PutSandboxService honors an explicit by param",
			call: func(c *Client) error {
				_, err := c.PutSandboxService(SandboxByRef("my-box"), "sbsvc_1", "id", SandboxServiceRequest{Name: "web", Port: 8080, URLScheme: "http"})
				return err
			},
			wantMethod: "PUT",
			wantPath:   "/api/v0beta1/sandboxes/my-box/services/sbsvc_1?by=id",
		},
		{
			name: "DeleteSandboxService resolves by name",
			call: func(c *Client) error {
				return c.DeleteSandboxService(SandboxByRef("my-box"), "web")
			},
			wantMethod: "DELETE",
			wantPath:   "/api/v0beta1/sandboxes/my-box/services/web?by=name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.RequestURI
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]any{"name": "web", "port": 3000, "url_scheme": "https"})
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

func TestCreateSandboxServiceSendsBody(t *testing.T) {
	var gotBody SandboxServiceRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"id":         "sbsvc_1",
			"sandbox_id": "sb_1",
			"name":       "web",
			"port":       3000,
			"url_scheme": "https",
			"protocol":   "tcp",
			"source":     "table",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	svc, err := c.CreateSandboxService(SandboxByRef("my-box"), SandboxServiceRequest{Name: "web", Port: 3000, URLScheme: "https"})
	if err != nil {
		t.Fatalf("CreateSandboxService: %v", err)
	}
	if gotBody.Name != "web" || gotBody.Port != 3000 || gotBody.URLScheme != "https" {
		t.Errorf("request body = %+v", gotBody)
	}
	if svc.ID == nil || *svc.ID != "sbsvc_1" {
		t.Errorf("ID = %v", svc.ID)
	}
	if svc.Name != "web" || svc.Port != 3000 || svc.URLScheme == nil || *svc.URLScheme != "https" || svc.Source != "table" {
		t.Errorf("service = %+v", svc)
	}
}
