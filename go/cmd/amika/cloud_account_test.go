package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testCloudAccountJSON = `{"id":"cacc_1","provider":"instabox","name":"prod","is_default":true,"created_at":"2026-11-12T00:00:00Z","updated_at":"2026-11-13T00:00:00Z"}`

func TestCloudAccountCreateReadsTheKeyFromAFile(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testCloudAccountJSON })
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte("  ib_secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	out, err := runRootCommandOutput(t, "cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-file", keyFile, "--default")
	if err != nil {
		t.Fatalf("cloud-account create: %v\n%s", err, out)
	}
	got := (*requests)[0]
	if got.method != "POST" || got.uri != "/api/v0beta1/cloud-accounts" {
		t.Fatalf("got %s %s", got.method, got.uri)
	}
	if want := `{"provider":"instabox","name":"prod","api_key":"ib_secret","is_default":true}`; got.body != want {
		t.Errorf("body = %s\nwant   %s", got.body, want)
	}
	for _, s := range []string{`Cloud account "prod" connected`, "cacc_1", "Default:   yes"} {
		if !strings.Contains(out, s) {
			t.Errorf("output lacks %q:\n%s", s, out)
		}
	}
	if strings.Contains(out, "ib_secret") {
		t.Errorf("output leaks the key:\n%s", out)
	}
}

func TestCloudAccountCreateReadsTheKeyFromStdinAndEnv(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testCloudAccountJSON })

	rootCmd.SetIn(strings.NewReader("from-stdin\n"))
	t.Cleanup(func() { rootCmd.SetIn(nil) })
	if _, err := runRootCommandOutput(t, "cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-file", "-", "-o", "json"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IB_KEY", "from-env")
	if _, err := runRootCommandOutput(t, "cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-env", "IB_KEY", "-o", "json"); err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{
		`{"provider":"instabox","name":"prod","api_key":"from-stdin"}`,
		`{"provider":"instabox","name":"prod","api_key":"from-env"}`,
	} {
		if got := (*requests)[i].body; got != want {
			t.Errorf("request %d body = %s, want %s", i, got, want)
		}
	}
}

func TestCloudAccountUsageErrorsMakeNoRequest(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testCloudAccountJSON })
	emptyKey := filepath.Join(t.TempDir(), "empty")
	if err := os.WriteFile(emptyKey, []byte(" \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("IB_EMPTY", " ")
	for _, tt := range []struct {
		args []string
		want string
	}{
		{[]string{"cloud-account", "create", "--name", "prod", "--api-key-env", "IB_EMPTY"}, "--provider is required"},
		{[]string{"cloud-account", "create", "--provider", "instabox", "--api-key-env", "IB_EMPTY"}, "--name is required"},
		{[]string{"cloud-account", "create", "--provider", "instabox", "--name", "prod"}, "pass the provider API key"},
		{[]string{"cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-file", emptyKey}, "API key is empty"},
		{[]string{"cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-env", "IB_EMPTY"}, "API key is empty"},
		{[]string{"cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-env", "IB_UNSET_FOR_TEST"}, "IB_UNSET_FOR_TEST is not set"},
		{[]string{"cloud-account", "create", "--provider", "instabox", "--name", "prod", "--api-key-file", emptyKey, "--api-key-env", "IB_EMPTY"}, "cannot be combined"},
		{[]string{"cloud-account", "update", "prod"}, "nothing to change"},
		{[]string{"cloud-account", "update", "prod", "--name", " "}, "--name must not be empty"},
		{[]string{"cloud-account", "get", "id="}, "is empty"},
	} {
		_, err := runRootCommandOutput(t, tt.args...)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%v: err = %v, want it to contain %q", tt.args, err, tt.want)
		}
	}
	if len(*requests) != 0 {
		t.Errorf("usage errors made %d requests", len(*requests))
	}
}

func TestCloudAccountReferencesAndProvider(t *testing.T) {
	requests := serveJobsAPI(t, func(r *http.Request) string {
		if r.Method == "DELETE" {
			return ""
		}
		return testCloudAccountJSON
	})
	t.Setenv("IB_KEY", "rotated")
	for _, tt := range []struct {
		args       []string
		wantMethod string
		wantURI    string
		wantBody   string
	}{
		{[]string{"cloud-account", "get", "prod"}, "GET", "/api/v0beta1/cloud-accounts/prod", ""},
		{[]string{"cloud-account", "get", "id=cacc_1"}, "GET", "/api/v0beta1/cloud-accounts/cacc_1?by=id", ""},
		{[]string{"cloud-account", "get", "name=prod", "--provider", "instabox"}, "GET", "/api/v0beta1/cloud-accounts/prod?by=name&provider=instabox", ""},
		{[]string{"cloud-account", "update", "prod", "--name", "main", "--api-key-env", "IB_KEY"}, "PATCH", "/api/v0beta1/cloud-accounts/prod", `{"name":"main","api_key":"rotated"}`},
		{[]string{"cloud-account", "set-default", "prod", "--provider", "instabox"}, "PATCH", "/api/v0beta1/cloud-accounts/prod?provider=instabox", `{"is_default":true}`},
		{[]string{"cloud-account", "unset-default", "name=prod"}, "PATCH", "/api/v0beta1/cloud-accounts/prod?by=name", `{"is_default":false}`},
		{[]string{"cloud-account", "delete", "prod", "--provider", "instabox", "--force"}, "DELETE", "/api/v0beta1/cloud-accounts/prod?provider=instabox", ""},
		{[]string{"cloud-account", "list", "--provider", "instabox"}, "GET", "/api/v0beta1/cloud-accounts?provider=instabox", ""},
	} {
		before := len(*requests)
		if out, err := runRootCommandOutput(t, tt.args...); err != nil {
			t.Errorf("%v: %v\n%s", tt.args, err, out)
			continue
		}
		got := (*requests)[before]
		if got.method != tt.wantMethod || got.uri != tt.wantURI || got.body != tt.wantBody {
			t.Errorf("%v: got %s %s %s, want %s %s %s", tt.args, got.method, got.uri, got.body, tt.wantMethod, tt.wantURI, tt.wantBody)
		}
	}
}

func TestCloudAccountListJSONMirrorsTheAPI(t *testing.T) {
	serveJobsAPI(t, func(*http.Request) string { return `{"items":[` + testCloudAccountJSON + `]}` })
	out, err := runRootCommandOutput(t, "cloud-account", "list", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != `{"items":[`+testCloudAccountJSON+`]}` {
		t.Errorf("out = %s", out)
	}

	out, err = runRootCommandOutput(t, "cloud-account", "list")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"PROVIDER", "instabox", "prod", "yes", "cacc_1"} {
		if !strings.Contains(out, s) {
			t.Errorf("table lacks %q:\n%s", s, out)
		}
	}
}

func TestCloudAccountDeleteJSONRequiresForce(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return "" })
	if _, err := runRootCommandOutput(t, "cloud-account", "delete", "prod", "-o", "json"); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a --force refusal", err)
	}
	out, err := runRootCommandOutput(t, "cloud-account", "delete", "prod", "--force", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 1 || (*requests)[0].method != "DELETE" {
		t.Fatalf("requests = %+v", *requests)
	}
	if strings.TrimSpace(out) != `[{"name":"prod","status":"deleted"}]` {
		t.Errorf("out = %s", out)
	}
}

func TestCloudAccountAmbiguousNameSuggestsProvider(t *testing.T) {
	ambiguous := `{"code":"resource_ref_ambiguous","message":"ambiguous"}`
	srvRequests := serveJobsAPIStatus(t, 409, ambiguous)
	_, err := runRootCommandOutput(t, "cloud-account", "get", "prod")
	if err == nil || !strings.Contains(err.Error(), "pass --provider") || !strings.Contains(err.Error(), `"id=prod"`) {
		t.Errorf("err = %v", err)
	}
	_, err = runRootCommandOutput(t, "cloud-account", "get", "name=prod")
	if err == nil || !strings.Contains(err.Error(), "more than one provider has a cloud account named") {
		t.Errorf("err = %v", err)
	}
	if len(*srvRequests) != 2 {
		t.Errorf("requests = %d", len(*srvRequests))
	}
}

// serveJobsAPIStatus points the CLI at a fake API that answers every request
// with status and body, and counts the requests.
func serveJobsAPIStatus(t *testing.T, status int, body string) *[]string {
	t.Helper()
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_KEY", "test-key")
	t.Setenv("AMIKA_API_URL", srv.URL)
	return &requests
}

func TestCloudAccountCreateHelpShowsBothKeySources(t *testing.T) {
	out, err := runRootCommandOutput(t, "cloud-account", "create", "--help")
	if err != nil {
		t.Fatal(err)
	}
	want := "Usage:\n" +
		"  amika cloud-account create --provider <provider> --name <name> --api-key-file <path> [flags]\n" +
		"  amika cloud-account create --provider <provider> --name <name> --api-key-env <var> [flags]\n"
	if !strings.Contains(out, want) {
		t.Errorf("help lacks\n%s\ngot:\n%s", want, out)
	}
}
