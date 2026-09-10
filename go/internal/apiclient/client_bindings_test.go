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
	binding, err := client.BindSandboxGitHubBranch("org/box", "gofixpoint", "amika", "feature/one", true)
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
