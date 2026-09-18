package sandboxcmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/spf13/cobra"
)

func TestFindSandboxBindingByTarget(t *testing.T) {
	bindings := []apiclient.SandboxBinding{
		{
			ID:              "sbind_pr",
			TargetNamespace: "github",
			TargetKind:      "pull_request",
			TargetURL:       "https://github.com/gofixpoint/amika/pull/1",
		},
		{
			ID:              "sbind_branch",
			TargetNamespace: "github",
			TargetKind:      "branch",
			TargetURL:       "https://github.com/GoFixPoint/Amika/tree/dylan/some-branch",
		},
	}

	got, err := findSandboxBindingByTarget(bindings, "gh-branch:gofixpoint/amika/dylan/some-branch")
	if err != nil {
		t.Fatalf("find binding: %v", err)
	}
	if got.ID != "sbind_branch" {
		t.Fatalf("binding ID = %q, want sbind_branch", got.ID)
	}
}

func TestFindSandboxBindingByTargetKeepsBranchCaseSensitive(t *testing.T) {
	bindings := []apiclient.SandboxBinding{{
		ID:              "sbind_branch",
		TargetNamespace: "github",
		TargetKind:      "branch",
		TargetURL:       "https://github.com/gofixpoint/amika/tree/Feature/One",
	}}

	_, err := findSandboxBindingByTarget(bindings, "gh-branch:gofixpoint/amika/feature/one")
	if err == nil || !strings.Contains(err.Error(), "no binding found") {
		t.Fatalf("error = %v, want no binding found", err)
	}
}

func TestFindSandboxBindingByTargetDecodesURLPath(t *testing.T) {
	bindings := []apiclient.SandboxBinding{{
		ID:              "sbind_branch",
		TargetNamespace: "github",
		TargetKind:      "branch",
		TargetURL:       "https://github.com/gofixpoint/amika/tree/feature/percent%25name",
	}}

	got, err := findSandboxBindingByTarget(bindings, "gh-branch:gofixpoint/amika/feature/percent%name")
	if err != nil {
		t.Fatalf("find binding: %v", err)
	}
	if got.ID != "sbind_branch" {
		t.Fatalf("binding ID = %q, want sbind_branch", got.ID)
	}
}

func TestFindSandboxBindingByTargetRejectsMultipleMatches(t *testing.T) {
	bindings := []apiclient.SandboxBinding{
		{ID: "sbind_1", TargetNamespace: "github", TargetKind: "branch", TargetURL: "https://github.com/gofixpoint/amika/tree/main"},
		{ID: "sbind_2", TargetNamespace: "github", TargetKind: "branch", TargetURL: "https://github.com/gofixpoint/amika/tree/main"},
	}

	_, err := findSandboxBindingByTarget(bindings, "gh-branch:gofixpoint/amika/main")
	if err == nil || !strings.Contains(err.Error(), "multiple bindings") {
		t.Fatalf("error = %v, want multiple bindings", err)
	}
}

func TestValidateSandboxBindingRefKind(t *testing.T) {
	for _, kind := range []string{"ref", "name", "id"} {
		if err := validateSandboxBindingRefKind(kind); err != nil {
			t.Errorf("validate %q: %v", kind, err)
		}
	}
	if err := validateSandboxBindingRefKind("name_or_id"); err == nil {
		t.Fatal("expected unsupported ref kind to fail")
	}
}

func TestSandboxBindingsDeleteUsageListsVariants(t *testing.T) {
	root := &cobra.Command{Use: "amika"}
	sandbox := &cobra.Command{Use: "sandbox"}
	bindings := &cobra.Command{Use: "bindings"}
	deleteCmd := &cobra.Command{
		Use:     "delete <binding-id>",
		Aliases: []string{"rm", "remove"},
		RunE:    func(*cobra.Command, []string) error { return nil },
	}
	deleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")
	deleteCmd.SetUsageTemplate(sandboxBindingsDeleteUsageTemplate)
	root.AddCommand(sandbox)
	sandbox.AddCommand(bindings)
	bindings.AddCommand(deleteCmd)

	usage := deleteCmd.UsageString()
	want := "Usage:\n" +
		"  amika sandbox bindings delete <binding-id> [flags]\n" +
		"  amika sandbox bindings delete <rig-ref> <target> [flags]\n"
	if !strings.HasPrefix(usage, want) {
		t.Fatalf("usage =\n%s\nwant prefix =\n%s", usage, want)
	}
}

func TestRunSandboxBindingsListJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.RequestURI != "/api/v0beta1/sandboxes/org%2Fbox/bindings?sandbox_by=id" {
			t.Errorf("request = %s %s", r.Method, r.RequestURI)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(apiclient.ListSandboxBindingsResponse{Items: []apiclient.SandboxBinding{{
			ID:              "sbind_1",
			SandboxID:       "sb_1",
			TargetNamespace: "github",
			TargetKind:      "branch",
			TargetID:        "123:main",
			TargetURL:       "https://github.com/gofixpoint/amika/tree/main",
			Relationship:    "workspace",
			Metadata:        map[string]any{},
			SystemMetadata:  map[string]any{},
			CreatedByKind:   "user",
			CreatedByID:     "user_1",
			CreatedAt:       "2026-09-13T12:00:00Z",
			UpdatedAt:       "2026-09-13T12:00:00Z",
		}}})
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	cmd := newBindingsTestCommand(t)
	if err := cmd.Flags().Set("rig", "org/box"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("rig-by", "id"); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd.SetOut(&out)
	if err := runSandboxBindingsList(cmd, nil); err != nil {
		t.Fatalf("run list: %v", err)
	}

	var got apiclient.ListSandboxBindingsResponse
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("decode output: %v\n%s", err, out.String())
	}
	if len(got.Items) != 1 || got.Items[0].ID != "sbind_1" {
		t.Fatalf("output = %+v", got)
	}
}

func TestRunSandboxBindingsDeleteByTargetJSON(t *testing.T) {
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.RequestURI)
		switch {
		case r.Method == http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(apiclient.ListSandboxBindingsResponse{Items: []apiclient.SandboxBinding{{
				ID:              "sbind_1",
				SandboxID:       "sb_1",
				TargetNamespace: "github",
				TargetKind:      "branch",
				TargetURL:       "https://github.com/gofixpoint/amika/tree/dylan/some-branch",
			}}})
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.RequestURI)
		}
	}))
	defer srv.Close()
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	cmd := newBindingsTestCommand(t)
	if err := cmd.Flags().Set("force", "true"); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	cmd.SetOut(&out)
	if err := runSandboxBindingsDelete(cmd, []string{"my-box", "gh-branch:gofixpoint/amika/dylan/some-branch"}); err != nil {
		t.Fatalf("run delete: %v", err)
	}

	wantRequests := []string{
		"GET /api/v0beta1/sandboxes/my-box/bindings?sandbox_by=ref",
		"DELETE /api/v0beta1/sandbox-bindings/sbind_1",
	}
	if strings.Join(requests, "\n") != strings.Join(wantRequests, "\n") {
		t.Fatalf("requests = %q, want %q", requests, wantRequests)
	}
	if got := strings.TrimSpace(out.String()); got != `{"name":"sbind_1","status":"deleted"}` {
		t.Fatalf("output = %s", got)
	}
}

func newBindingsTestCommand(t *testing.T) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{}
	cmd.Flags().Bool("local", false, "")
	cmd.Flags().String("remote-target", "", "")
	cmd.Flags().String("output", "json", "")
	cmd.Flags().String("rig", "", "")
	cmd.Flags().String("rig-by", "ref", "")
	cmd.Flags().Bool("force", false, "")
	return cmd
}
