package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// testAPIKeyValue is the plaintext key the fake control plane mints. Every
// test that reaches the API checks it never shows up in the command's output.
const testAPIKeyValue = "sk_test_DO_NOT_PRINT_0123456789"

// apiKeyAPIStub is a fake control plane for POST /api/v0beta1/api-keys that
// records each request body it was sent.
type apiKeyAPIStub struct {
	mu sync.Mutex
	// status is what the create answers; 201 mints a key.
	status int
	bodies []map[string]any
}

func (s *apiKeyAPIStub) requests() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.bodies...)
}

// stubAPIKeyAPI points the CLI's client and its auth at a fake control plane
// and isolates the state directory, so no stored credential leaks in.
func stubAPIKeyAPI(t *testing.T) *apiKeyAPIStub {
	t.Helper()
	stub := &apiKeyAPIStub{status: http.StatusCreated}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/api/v0beta1/api-keys" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		stub.mu.Lock()
		stub.bodies = append(stub.bodies, body)
		status := stub.status
		stub.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != http.StatusCreated {
			json.NewEncoder(w).Encode(map[string]any{
				"type": "forbidden", "code": "forbidden", "message": "not allowed to create API keys",
			})
			return
		}
		scope, _ := body["scope"].(string)
		if scope == "" {
			scope = "organization"
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "key_01TEST", "name": body["name"], "scope": scope,
			"obfuscatedValue": "sk_...6789", "lastUsedAt": nil,
			"createdAt": "2026-10-12T00:00:00Z", "updatedAt": "2026-10-12T00:00:00Z",
			"value": testAPIKeyValue,
		})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	return stub
}

// assertNoKey fails the test if the plaintext key appears in the command's
// combined stdout and stderr or in its error.
func assertNoKey(t *testing.T, out string, err error) {
	t.Helper()
	if strings.Contains(out, testAPIKeyValue) {
		t.Fatalf("output contains the API key: %q", out)
	}
	if err != nil && strings.Contains(err.Error(), testAPIKeyValue) {
		t.Fatalf("error contains the API key: %v", err)
	}
}

// dirEntries lists a directory's names, so a test can show that a failed run
// left neither the key file nor a temp file behind.
func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

// A successful create writes exactly the key and a newline to a 0600 file,
// reports the key's id and obfuscated value, and never prints the key. With
// no --scope the request omits the field so the server default applies.
func TestAuthAPIKeyCreateWritesKeyFileOnly(t *testing.T) {
	stub := stubAPIKeyAPI(t)
	out := filepath.Join(t.TempDir(), "key")

	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--name", " build-01-hostd ", "--out", out)
	assertNoKey(t, got, err)
	if err != nil {
		t.Fatalf("create: %v\n%s", err, got)
	}

	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != testAPIKeyValue+"\n" {
		t.Fatalf("file contents = %q, want the bare key and a newline", data)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode = %o, want 600", perm)
	}
	if entries := dirEntries(t, filepath.Dir(out)); len(entries) != 1 {
		t.Fatalf("directory holds %v, want only the key file (no temp file left)", entries)
	}

	want := `Created API key "build-01-hostd" (key_01TEST, scope organization, sk_...6789) and wrote it to ` + out
	if !strings.Contains(got, want) {
		t.Fatalf("output = %q, want it to contain %q", got, want)
	}

	reqs := stub.requests()
	if len(reqs) != 1 {
		t.Fatalf("requests = %v, want one", reqs)
	}
	if reqs[0]["name"] != "build-01-hostd" {
		t.Errorf("name sent = %v, want it trimmed", reqs[0]["name"])
	}
	if _, ok := reqs[0]["scope"]; ok {
		t.Errorf("scope sent = %v, want it omitted so the server default applies", reqs[0]["scope"])
	}
}

// -o json emits the API's ApiKeySummary shape, camelCase and with a null
// lastUsedAt, and leaves out the key's value. --scope is passed through.
func TestAuthAPIKeyCreateJSONOmitsValue(t *testing.T) {
	stub := stubAPIKeyAPI(t)
	out := filepath.Join(t.TempDir(), "key")

	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--name", "laptop", "--scope", "user", "--out", out, "-o", "json")
	assertNoKey(t, got, err)
	if err != nil {
		t.Fatalf("create: %v\n%s", err, got)
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(got), &fields); err != nil {
		t.Fatalf("stdout is not one JSON value: %v\n%s", err, got)
	}
	keys := []string{}
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	wantKeys := []string{"createdAt", "id", "lastUsedAt", "name", "obfuscatedValue", "scope", "updatedAt"}
	if strings.Join(keys, ",") != strings.Join(wantKeys, ",") {
		t.Fatalf("JSON keys = %v, want %v", keys, wantKeys)
	}
	if string(fields["lastUsedAt"]) != "null" {
		t.Errorf("lastUsedAt = %s, want an explicit null", fields["lastUsedAt"])
	}
	if string(fields["scope"]) != `"user"` {
		t.Errorf("scope = %s, want \"user\"", fields["scope"])
	}
	if reqs := stub.requests(); len(reqs) != 1 || reqs[0]["scope"] != "user" {
		t.Fatalf("requests = %v, want one with scope user", reqs)
	}
	if data, _ := os.ReadFile(out); string(data) != testAPIKeyValue+"\n" {
		t.Fatalf("file contents = %q", data)
	}
}

// Bad invocations are refused before any request, and leave nothing on disk:
// a missing --name or --out, an existing --out, and an unknown --scope.
func TestAuthAPIKeyCreateRejectsBadFlagsBeforeCallingAPI(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"missing name", []string{"--out", "KEYFILE"}, `required flag(s) "name" not set`},
		{"missing out", []string{"--name", "k"}, `required flag(s) "out" not set`},
		{"blank name", []string{"--name", "  ", "--out", "KEYFILE"}, "--name must not be empty"},
		{"out directory", []string{"--name", "k", "--out", "DIR"}, "already exists"},
		{"invalid scope", []string{"--name", "k", "--scope", "team", "--out", "KEYFILE"}, `invalid --scope "team"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := stubAPIKeyAPI(t)
			dir := t.TempDir()
			args := []string{"auth", "api-key", "create"}
			for _, a := range tc.args {
				switch a {
				case "KEYFILE":
					a = filepath.Join(dir, "key")
				case "DIR":
					a = dir
				}
				args = append(args, a)
			}

			got, err := runRootCommandOutput(t, args...)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to contain %q\n%s", err, tc.wantErr, got)
			}
			if reqs := stub.requests(); len(reqs) != 0 {
				t.Fatalf("requests = %v, want none", reqs)
			}
			if entries := dirEntries(t, dir); len(entries) != 0 {
				t.Fatalf("directory holds %v, want nothing", entries)
			}
		})
	}
}

// An existing --out is refused without --force before any key is minted, and
// left untouched. With --force it is replaced by a 0600 file, even when the
// file it replaces was world-readable.
func TestAuthAPIKeyCreateExistingFile(t *testing.T) {
	stub := stubAPIKeyAPI(t)
	out := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(out, []byte("old contents\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--name", "k", "--out", out)
	if err == nil || !strings.Contains(err.Error(), "already exists; pass --force") {
		t.Fatalf("err = %v, want an already-exists refusal\n%s", err, got)
	}
	if reqs := stub.requests(); len(reqs) != 0 {
		t.Fatalf("requests = %v, want none: the key must not be minted into a file it cannot write", reqs)
	}
	if data, _ := os.ReadFile(out); string(data) != "old contents\n" {
		t.Fatalf("existing file changed to %q", data)
	}

	got, err = runRootCommandOutput(t, "auth", "api-key", "create", "--name", "k", "--out", out, "--force")
	assertNoKey(t, got, err)
	if err != nil {
		t.Fatalf("create --force: %v\n%s", err, got)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("replaced file mode = %o, want 600", perm)
	}
	if data, _ := os.ReadFile(out); string(data) != testAPIKeyValue+"\n" {
		t.Fatalf("replaced file contents = %q", data)
	}
}

// When the API refuses the create, the key file opened for it is removed.
func TestAuthAPIKeyCreateAPIErrorLeavesNoFile(t *testing.T) {
	stub := stubAPIKeyAPI(t)
	stub.status = http.StatusForbidden
	dir := t.TempDir()

	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--name", "k", "--out", filepath.Join(dir, "key"))
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
		t.Fatalf("err = %v, want the API's 403\n%s", err, got)
	}
	if entries := dirEntries(t, dir); len(entries) != 0 {
		t.Fatalf("directory holds %v, want nothing", entries)
	}
}

// With --force, an API error leaves the existing file as it was: it is
// emptied only once a key has arrived to replace it.
func TestAuthAPIKeyCreateForceAPIErrorKeepsExistingFile(t *testing.T) {
	stub := stubAPIKeyAPI(t)
	stub.status = http.StatusForbidden
	out := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(out, []byte("old key\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--name", "k", "--out", out, "--force")
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
		t.Fatalf("err = %v, want the API's 403\n%s", err, got)
	}
	if data, _ := os.ReadFile(out); string(data) != "old key\n" {
		t.Fatalf("existing file changed to %q", data)
	}
}

// A 2xx answer that holds no key is an error, not a created key, and leaves
// no file behind.
func TestAuthAPIKeyCreateResponseWithoutKeyFails(t *testing.T) {
	stub := stubAPIKeyAPI(t)
	stub.status = http.StatusOK
	dir := t.TempDir()

	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--name", "k", "--out", filepath.Join(dir, "key"))
	if err == nil || !strings.Contains(err.Error(), "response holds no key") {
		t.Fatalf("err = %v, want a no-key error\n%s", err, got)
	}
	if strings.Contains(got, "Created API key") {
		t.Fatalf("reported success for a response without a key:\n%s", got)
	}
	if entries := dirEntries(t, dir); len(entries) != 0 {
		t.Fatalf("directory holds %v, want nothing", entries)
	}
}

// The help text documents the flags and the file's format, and its example
// pipes the file into amika-hostd.
func TestAuthAPIKeyCreateHelp(t *testing.T) {
	got, err := runRootCommandOutput(t, "auth", "api-key", "create", "--help")
	if err != nil {
		t.Fatalf("help: %v", err)
	}
	for _, want := range []string{
		"amika auth api-key create [flags]",
		"--name", "--out", "--scope", "--force",
		"mode 0600",
		`amika-hostd setup --non-interactive --hostname build-01 < "$dir/api-key"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("help is missing %q:\n%s", want, got)
		}
	}
}
