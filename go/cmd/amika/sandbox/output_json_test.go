package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/spf13/cobra"
)

func TestRemoteSandboxFromInfo(t *testing.T) {
	info := sandbox.Info{
		Name:        "box",
		Provider:    "docker",
		ContainerID: "abc123",
		Image:       "img:latest",
		Branch:      "main",
		CreatedAt:   "2026-01-02T00:00:00Z",
		Mounts: []sandbox.MountBinding{
			{Type: "bind", Source: "/host/amika", Target: sandbox.SandboxWorkdir + "/amika", Mode: "rw"},
		},
		Ports: []sandbox.PortBinding{{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"}},
		Services: []sandbox.ServiceInfo{{
			Name:  "web",
			Ports: []sandbox.ServicePortInfo{{PortBinding: sandbox.PortBinding{HostPort: 8080, ContainerPort: 80}, URL: "http://x"}},
		}},
	}
	sb := remoteSandboxFromInfo(info, "running")
	if sb.ID != "box" || sb.Name != "box" {
		t.Fatalf("ID/Name = %q/%q, want box/box", sb.ID, sb.Name)
	}
	if sb.Provider == nil || *sb.Provider != "docker" {
		t.Errorf("Provider = %v, want docker", sb.Provider)
	}
	if sb.Branch == nil || *sb.Branch != "main" {
		t.Errorf("Branch = %v, want main", sb.Branch)
	}
	if sb.State != "running" {
		t.Errorf("State = %q, want running", sb.State)
	}
	if sb.ContainerID != "abc123" || sb.Image != "img:latest" {
		t.Errorf("ContainerID/Image = %q/%q", sb.ContainerID, sb.Image)
	}
	if len(sb.Services) != 1 || sb.Services[0].Name != "web" || sb.Services[0].URL != "http://x" || sb.Services[0].HostPort != 8080 {
		t.Fatalf("Services = %+v", sb.Services)
	}
	// A local sandbox has an equivalent of each of these, so the mirror answers
	// them under the same field name a remote sandbox would: the base it was
	// built from is its image, and its repos are its workspace mounts.
	if sb.Snapshot == nil || *sb.Snapshot != "img:latest" {
		t.Errorf("Snapshot = %v, want img:latest", sb.Snapshot)
	}
	if sb.RepoName == nil || *sb.RepoName != "amika" {
		t.Errorf("RepoName = %v, want amika", sb.RepoName)
	}
	// The ones with no local equivalent at all still stay null/empty. RepoURL
	// among them: local repos are mount targets, so their name is derivable and
	// their origin URL is not.
	if sb.OrgID != "" {
		t.Errorf("OrgID = %q, want empty", sb.OrgID)
	}
	if sb.UserID != nil || sb.ProviderURL != nil || sb.RepoURL != nil || sb.CreatedBy != nil {
		t.Errorf("API-only nullable fields should be nil: user_id=%v provider_url=%v repo_url=%v created_by=%v", sb.UserID, sb.ProviderURL, sb.RepoURL, sb.CreatedBy)
	}

	var buf bytes.Buffer
	if err := output.FormatJSON.JSON(&buf, normalizeSandboxJSON(sb)); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"id":"box"`,
		`"name":"box"`,
		`"container_id":"abc123"`,
		`"hostPort":8080`,
		`"services":[{"name":"web"`,
		`"url":"http://x"`,
		`"user_id":null`,
		`"provider_url":null`,
		`"snapshot":"img:latest"`,
		`"repo_name":"amika"`,
	} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("detail JSON missing %q, got:\n%s", want, buf.String())
		}
	}
}

func TestNormalizeSandboxJSON_ServicesNeverNull(t *testing.T) {
	sb := apiclient.RemoteSandbox{ID: "a", Name: "a"}
	if sb.Services != nil {
		t.Fatalf("precondition: Services should start nil")
	}
	got := normalizeSandboxJSON(sb)
	if got.Services == nil {
		t.Fatal("normalizeSandboxJSON should turn a nil Services into an empty slice")
	}

	var buf bytes.Buffer
	if err := output.FormatJSON.JSON(&buf, got); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"services":[]`) {
		t.Errorf("expected services:[], got: %s", buf.String())
	}
}

// TestSandboxListLocalJSON_EmitsAPISandboxShape guards decision 2 of the
// output-format work: a local (Docker) sandbox's `sandbox list -o json`
// output must be an apiclient.RemoteSandbox array, the same API shape used
// for remote sandboxes, with local-meaningful fields populated (id/name,
// provider, branch, services) and API-only fields left null/empty.
func TestSandboxListLocalJSON_EmitsAPISandboxShape(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)

	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(sandbox.Info{
		Name:        "sb-a",
		Provider:    "docker",
		ContainerID: "abc123",
		Image:       "img:latest",
		CreatedAt:   "2026-01-02T00:00:00Z",
		Branch:      "main",
		Mounts: []sandbox.MountBinding{
			{Type: "bind", Source: "/host/amika", Target: sandbox.SandboxWorkdir + "/amika", Mode: "rw"},
		},
		Services: []sandbox.ServiceInfo{{
			Name: "web",
			Ports: []sandbox.ServicePortInfo{{
				PortBinding: sandbox.PortBinding{HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"},
				URL:         "http://localhost:3000",
			}},
		}},
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	root := &cobra.Command{Use: "amika"}
	output.AddFlag(root)
	root.AddCommand(New())
	root.SetArgs([]string{"sandbox", "list", "--local", "-o", "json"})
	var buf bytes.Buffer
	root.SetOut(&buf)
	if err := root.Execute(); err != nil {
		t.Fatalf("execute: %v\noutput: %s", err, buf.String())
	}

	var got []apiclient.RemoteSandbox
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v\noutput: %s", err, buf.String())
	}
	if len(got) != 1 {
		t.Fatalf("got %d items, want 1: %s", len(got), buf.String())
	}
	sb := got[0]
	if sb.ID != "sb-a" || sb.Name != "sb-a" {
		t.Errorf("ID/Name = %q/%q, want sb-a/sb-a", sb.ID, sb.Name)
	}
	if sb.Provider == nil || *sb.Provider != "docker" {
		t.Errorf("Provider = %v, want docker", sb.Provider)
	}
	if sb.Branch == nil || *sb.Branch != "main" {
		t.Errorf("Branch = %v, want main", sb.Branch)
	}
	// Every fact `--long` shows is answerable from this JSON too, under the
	// field name a remote sandbox would use, so a script does not have to know
	// which kind it is reading.
	if sb.State == "" {
		t.Errorf("State = %q, want a state", sb.State)
	}
	if sb.CreatedAt != "2026-01-02T00:00:00Z" {
		t.Errorf("CreatedAt = %q", sb.CreatedAt)
	}
	if sb.Snapshot == nil || *sb.Snapshot != "img:latest" {
		t.Errorf("Snapshot = %v, want img:latest", sb.Snapshot)
	}
	if sb.RepoName == nil || *sb.RepoName != "amika" {
		t.Errorf("RepoName = %v, want amika", sb.RepoName)
	}
	// The id the table shows for a local sandbox is its container, which the
	// mirror carries separately: `id` stays the name, which is what addresses a
	// local sandbox in every other command.
	if sb.ContainerID != "abc123" {
		t.Errorf("ContainerID = %q, want abc123", sb.ContainerID)
	}
	// The fields with no local equivalent at all still stay null/empty.
	if sb.OrgID != "" {
		t.Errorf("OrgID = %q, want empty", sb.OrgID)
	}
	if sb.UserID != nil || sb.ProviderURL != nil || sb.RepoURL != nil || sb.CreatedBy != nil {
		t.Errorf("API-only nullable fields should be nil: user_id=%v provider_url=%v repo_url=%v created_by=%v", sb.UserID, sb.ProviderURL, sb.RepoURL, sb.CreatedBy)
	}
	if len(sb.Services) != 1 || sb.Services[0].Name != "web" || sb.Services[0].URL != "http://localhost:3000" || sb.Services[0].HostPort != 3000 {
		t.Fatalf("Services = %+v", sb.Services)
	}
	// ContainerID/Image have no schema field but are preserved as CLI
	// extensions rather than dropped.
	if sb.Image != "img:latest" {
		t.Errorf("Image = %q, want img:latest", sb.Image)
	}
}

func TestFinishBatch(t *testing.T) {
	newCmd := func() (*cobra.Command, *bytes.Buffer) {
		buf := &bytes.Buffer{}
		c := &cobra.Command{}
		c.SetOut(buf)
		return c, buf
	}

	t.Run("json empty is empty array", func(t *testing.T) {
		c, buf := newCmd()
		if err := finishBatch(c, output.FormatJSON, nil, nil); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if buf.String() != "[]\n" {
			t.Fatalf("got %q, want %q", buf.String(), "[]\n")
		}
	})

	t.Run("json with failure returns error and emits results", func(t *testing.T) {
		c, buf := newCmd()
		var items []any
		var failed []string
		items = append(items, apiclient.RemoteSandbox{ID: "a", Name: "a", Services: []apiclient.RemoteSandboxService{}})
		appendBatchFailure(&items, &failed, "b", errors.New("boom"))
		err := finishBatch(c, output.FormatJSON, items, failed)
		if err == nil {
			t.Fatal("expected error when an item failed")
		}
		if !strings.Contains(buf.String(), `"status":"error"`) || !strings.Contains(buf.String(), `"error":"boom"`) {
			t.Fatalf("JSON missing failure detail: %s", buf.String())
		}
		if !strings.Contains(buf.String(), `"name":"a"`) {
			t.Fatalf("JSON missing successful resource: %s", buf.String())
		}
	})

	t.Run("text with failure returns combined error, no stdout", func(t *testing.T) {
		c, buf := newCmd()
		var items []any
		var failed []string
		appendBatchFailure(&items, &failed, "b", errors.New("boom"))
		err := finishBatch(c, output.FormatText, items, failed)
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("expected combined error, got %v", err)
		}
		if buf.Len() != 0 {
			t.Fatalf("text finishBatch should not write to stdout, got %q", buf.String())
		}
	})
}
