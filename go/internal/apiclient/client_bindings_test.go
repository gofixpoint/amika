package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBindSandboxGitHubBranch(t *testing.T) {
	var got GitHubBranchBindingRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.RequestURI != "/api/v0beta1/sandboxes/org%2Fbox/bindings?sandbox_by=ref" {
			t.Errorf("request URI = %q", r.RequestURI)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(SandboxBindingReference{ID: "sbind_1"})
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	binding, err := client.BindSandboxGitHubBranch("org/box", "ref", "gofixpoint", "amika", "feature/one", true)
	if err != nil {
		t.Fatalf("BindSandboxGitHubBranch: %v", err)
	}
	if binding.ID != "sbind_1" {
		t.Errorf("binding ID = %q, want sbind_1", binding.ID)
	}
	if got.Target.Kind != "github_branch" || got.Target.Repository.Owner != "gofixpoint" || got.Target.Repository.Name != "amika" || got.Target.Branch != "feature/one" || !got.Rebind {
		t.Errorf("request = %+v", got)
	}
}

func TestListSandboxBindings(t *testing.T) {
	tests := []struct {
		name       string
		sandboxRef string
		sandboxBy  string
		wantURI    string
	}{
		{
			name:    "organization",
			wantURI: "/api/v0beta1/sandbox-bindings",
		},
		{
			name:       "sandbox by explicit name",
			sandboxRef: "org/box",
			sandboxBy:  "name",
			wantURI:    "/api/v0beta1/sandboxes/org%2Fbox/bindings?sandbox_by=name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("method = %q, want GET", r.Method)
				}
				if r.RequestURI != tt.wantURI {
					t.Errorf("request URI = %q, want %q", r.RequestURI, tt.wantURI)
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(ListSandboxBindingsResponse{Items: []SandboxBinding{{
					ID:              "sbind_1",
					SandboxID:       "sb_1",
					TargetNamespace: "github",
					TargetKind:      "branch",
					TargetID:        "123:feature/one",
					TargetURL:       "https://github.com/gofixpoint/amika/tree/feature/one",
					Metadata:        map[string]any{},
					SystemMetadata:  map[string]any{},
				}}})
			}))
			defer srv.Close()

			client := NewClient(srv.URL, "test-token")
			var result *ListSandboxBindingsResponse
			var err error
			if tt.sandboxRef == "" {
				result, err = client.ListSandboxBindings()
			} else {
				result, err = client.ListSandboxBindingsForSandbox(tt.sandboxRef, tt.sandboxBy)
			}
			if err != nil {
				t.Fatalf("list bindings: %v", err)
			}
			if len(result.Items) != 1 || result.Items[0].ID != "sbind_1" {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

func TestDeleteSandboxBinding(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("method = %q, want DELETE", r.Method)
		}
		if r.RequestURI != "/api/v0beta1/sandbox-bindings/weird%2Fid" {
			t.Errorf("request URI = %q", r.RequestURI)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	client := NewClient(srv.URL, "test-token")
	if err := client.DeleteSandboxBinding("weird/id"); err != nil {
		t.Fatalf("DeleteSandboxBinding: %v", err)
	}
}
