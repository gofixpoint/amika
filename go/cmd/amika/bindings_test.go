package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testBindingResource = `{
  "id":"sbind_1",
  "sandbox_id":"sb_1",
  "target_namespace":"github",
  "target_kind":"pull_request",
  "target_id":"123:42",
  "target_url":"https://github.com/acme/widgets/pull/42",
  "relationship":"workspace",
  "metadata":{},
  "system_metadata":{"repository_id":123,"pull_request_number":42},
  "created_by_kind":"user",
  "created_by_id":"user_1",
  "created_at":"2026-09-09T00:00:00.000Z",
  "updated_at":"2026-09-09T00:00:00.000Z"
}`

func TestBindCommandSendsTargetInBodyAndMirrorsCreateResponse(t *testing.T) {
	const targetURL = "https://github.com/acme/widgets/pull/42?view=files#discussion"
	var gotMethod, gotURI string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		gotMethod = request.Method
		gotURI = request.RequestURI
		if err := json.NewDecoder(request.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"id":"sbind_1"}`)
	}))
	defer server.Close()
	setBindingTestEnvironment(t, server.URL)

	out, err := runRootCommandOutput(t, "bind", "team/runner box", targetURL, "-o", "json")
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if out != `{"id":"sbind_1"}`+"\n" {
		t.Errorf("output = %q", out)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotURI != "/api/v0beta1/sandboxes/team%2Frunner%20box/bindings?sandbox_by=ref" {
		t.Errorf("request URI = %q", gotURI)
	}
	if gotBody["target_url"] != targetURL || len(gotBody) != 1 {
		t.Errorf("request body = %#v", gotBody)
	}
	if strings.Contains(gotURI, "github.com") {
		t.Errorf("target URL leaked into path: %q", gotURI)
	}
}

func TestBindCommandTextOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"id":"sbind_1"}`)
	}))
	defer server.Close()
	setBindingTestEnvironment(t, server.URL)

	out, err := runRootCommandOutput(t, "bind", "box", "https://github.com/acme/widgets/pull/42")
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if out != "Created binding sbind_1\n" {
		t.Errorf("output = %q", out)
	}
}

func TestBindingsListJSONMirrorsAPIEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.RequestURI != "/api/v0beta1/sandbox-bindings" {
			t.Errorf("request = %s %s", request.Method, request.RequestURI)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[`+testBindingResource+`]}`)
	}))
	defer server.Close()
	setBindingTestEnvironment(t, server.URL)

	out, err := runRootCommandOutput(t, "bindings", "list", "-o", "json")
	if err != nil {
		t.Fatalf("bindings list: %v", err)
	}
	var response struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatalf("decode output: %v\n%s", err, out)
	}
	if len(response.Items) != 1 {
		t.Fatalf("items = %#v", response.Items)
	}
	item := response.Items[0]
	for _, key := range []string{
		"id", "sandbox_id", "target_namespace", "target_kind", "target_id",
		"target_url", "relationship", "metadata", "system_metadata",
		"created_by_kind", "created_by_id", "created_at", "updated_at",
	} {
		if _, ok := item[key]; !ok {
			t.Errorf("output item missing %q: %s", key, out)
		}
	}
}

func TestBindingsListEmptyOutputs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	setBindingTestEnvironment(t, server.URL)

	out, err := runRootCommandOutput(t, "bindings", "list", "-o", "json")
	if err != nil {
		t.Fatalf("bindings list JSON: %v", err)
	}
	if out != `{"items":[]}`+"\n" {
		t.Errorf("JSON output = %q", out)
	}

	out, err = runRootCommandOutput(t, "bindings", "list")
	if err != nil {
		t.Fatalf("bindings list text: %v", err)
	}
	if out != "No sandbox bindings found.\n" {
		t.Errorf("text output = %q", out)
	}
}

func TestBindingsListTextTable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[`+testBindingResource+`]}`)
	}))
	defer server.Close()
	setBindingTestEnvironment(t, server.URL)

	out, err := runRootCommandOutput(t, "bindings", "list")
	if err != nil {
		t.Fatalf("bindings list: %v", err)
	}
	for _, value := range []string{
		"ID", "SANDBOX", "TYPE", "TARGET", "RELATIONSHIP", "CREATED",
		"sbind_1", "sb_1", "github/pull_request",
		"https://github.com/acme/widgets/pull/42", "workspace",
	} {
		if !strings.Contains(out, value) {
			t.Errorf("text output missing %q:\n%s", value, out)
		}
	}
}

func TestBindingDeleteCommandAndAliases(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "delete", args: []string{"bindings", "delete", "sbind_1"}},
		{name: "rm alias", args: []string{"bindings", "rm", "sbind_1"}},
		{name: "root unbind alias", args: []string{"unbind", "sbind_1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotURI string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				gotMethod = request.Method
				gotURI = request.RequestURI
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			setBindingTestEnvironment(t, server.URL)

			args := append(append([]string{}, tt.args...), "-o", "json")
			out, err := runRootCommandOutput(t, args...)
			if err != nil {
				t.Fatalf("delete binding: %v", err)
			}
			if out != `{"name":"sbind_1","status":"deleted"}`+"\n" {
				t.Errorf("output = %q", out)
			}
			if gotMethod != http.MethodDelete || gotURI != "/api/v0beta1/sandbox-bindings/sbind_1" {
				t.Errorf("request = %s %s", gotMethod, gotURI)
			}
		})
	}
}

func TestBindingsHelpShowsDeleteAliasAndRootCommands(t *testing.T) {
	out, err := runRootCommandOutput(t, "bindings", "--help")
	if err != nil {
		t.Fatalf("bindings help: %v", err)
	}
	if !helpLineContains(out, "delete", "(aliases: rm)") {
		t.Errorf("bindings help does not show rm alias:\n%s", out)
	}
	if !helpLineContains(out, "list", "List sandbox bindings") {
		t.Errorf("bindings help does not show list:\n%s", out)
	}

	out, err = runRootCommandOutput(t, "--help")
	if err != nil {
		t.Fatalf("root help: %v", err)
	}
	for _, command := range []string{"bind", "bindings", "unbind"} {
		if !helpLineContains(out, command) {
			t.Errorf("root help does not show %q:\n%s", command, out)
		}
	}
}

func TestBindingCommandsValidateArguments(t *testing.T) {
	tests := []struct {
		args []string
		want string
	}{
		{args: []string{"bind", "box"}, want: "accepts 2 arg"},
		{args: []string{"bindings", "list", "extra"}, want: "unknown command"},
		{args: []string{"bindings", "delete"}, want: "accepts 1 arg"},
		{args: []string{"unbind"}, want: "accepts 1 arg"},
	}
	for _, tt := range tests {
		_, err := runRootCommandOutput(t, tt.args...)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%v: error = %v, want containing %q", tt.args, err, tt.want)
		}
	}
}

func TestBindingCommandsSurfaceRemoteErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"code":"sandbox_binding_conflict"}`)
	}))
	defer server.Close()
	setBindingTestEnvironment(t, server.URL)

	_, err := runRootCommandOutput(t, "bind", "box", "https://github.com/acme/widgets/pull/42")
	if err == nil || !strings.Contains(err.Error(), "remote create sandbox binding") || !strings.Contains(err.Error(), "409") {
		t.Fatalf("error = %v", err)
	}
}

func setBindingTestEnvironment(t *testing.T, apiURL string) {
	t.Helper()
	t.Setenv("AMIKA_API_URL", apiURL)
	t.Setenv("AMIKA_API_KEY", "test-token")
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
}
