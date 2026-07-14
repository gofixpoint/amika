package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
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

func TestResolveSandboxID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": "sb-1", "name": "alpha", "state": "active"},
			{"id": "sb-2", "name": "beta", "state": "active"},
		})
	}))
	defer srv.Close()
	client := apiclient.NewClient(srv.URL, "tok")

	if id, err := resolveSandboxID(client, "sb-2"); err != nil || id != "sb-2" {
		t.Errorf("by id: got %q, %v", id, err)
	}
	if id, err := resolveSandboxID(client, "alpha"); err != nil || id != "sb-1" {
		t.Errorf("by name: got %q, %v", id, err)
	}
	if _, err := resolveSandboxID(client, "missing"); err == nil {
		t.Error("expected not-found error")
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
	c.Flags().String("sandbox", "", "")
	c.Flags().String("name", "", "")
	c.Flags().String("mode", "", "")
	c.Flags().String("description", "", "")
	c.Flags().Bool("no-interactive", false, "")
	return c
}

func TestSnapshotCreateNoInteractiveValidation(t *testing.T) {
	t.Run("requires sandbox", func(t *testing.T) {
		c := newTestCreateCmd()
		if err := runSnapshotCreate(c, nil); err == nil ||
			!strings.Contains(err.Error(), "--sandbox is required") {
			t.Errorf("got %v", err)
		}
	})

	t.Run("requires mode without interactive", func(t *testing.T) {
		c := newTestCreateCmd()
		c.Flags().Set("sandbox", "box")
		c.Flags().Set("no-interactive", "true")
		if err := runSnapshotCreate(c, nil); err == nil ||
			!strings.Contains(err.Error(), "--mode is required") {
			t.Errorf("got %v", err)
		}
	})

	t.Run("requires name without interactive", func(t *testing.T) {
		c := newTestCreateCmd()
		c.Flags().Set("sandbox", "box")
		c.Flags().Set("no-interactive", "true")
		c.Flags().Set("mode", "full")
		if err := runSnapshotCreate(c, nil); err == nil ||
			!strings.Contains(err.Error(), "--name is required") {
			t.Errorf("got %v", err)
		}
	})
}
