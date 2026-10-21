package main

// rigref_commands_test.go covers the rig references `send --rig` and
// `agent-send <rig>` accept and what each reference kind puts on the wire,
// plus, for every command that names a rig, that the reference is parsed
// before the auth check.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// TestSendRigReferenceKinds checks that send makes exactly one request, the
// agent-sessions POST, routing the message by the field the reference's kind
// calls for: a bare value goes in sandbox_ref (the server resolves an id or a
// name and refuses an ambiguous value), name= in sandbox_name, and id= in
// sandbox_id. agent-send routes the same way.
func TestSendRigReferenceKinds(t *testing.T) {
	var body map[string]any
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"session_id":"chat_1","sandbox_id":"sb_1","agent":"claude","response":"ok","is_error":false,"is_new_session":false,"created_sandbox":false}`))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	cases := []struct {
		name string
		args []string
		want map[string]any
	}{
		{"bare", []string{"send", "hi", "--rig", "my-rig"}, map[string]any{"sandbox_ref": "my-rig"}},
		{"name=", []string{"send", "hi", "--rig", "name=my-rig"}, map[string]any{"sandbox_name": "my-rig"}},
		{"id=", []string{"send", "hi", "--rig", "id=sb_1"}, map[string]any{"sandbox_id": "sb_1"}},
		{"agent-send name=", []string{"rig", "agent-send", "name=my-rig", "hi"}, map[string]any{"sandbox_name": "my-rig"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body, requests = nil, nil
			if _, err := runRootCommandOutput(t, append(tc.args, "--output", "json")...); err != nil {
				t.Fatal(err)
			}
			if want := []string{"POST /api/v0beta1/agent-sessions"}; !reflect.DeepEqual(requests, want) {
				t.Fatalf("requests = %q, want %q", requests, want)
			}
			want := map[string]any{"message": "hi"}
			for key, value := range tc.want {
				want[key] = value
			}
			if !reflect.DeepEqual(body, want) {
				t.Fatalf("body = %v, want %v", body, want)
			}
		})
	}
}

// TestSendAmbiguousRigSuggestsPrefixes checks that the server's 409 for an
// ambiguous plain reference becomes a hint naming both prefixed spellings.
func TestSendAmbiguousRigSuggestsPrefixes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"resource_ref_ambiguous","message":"more than one sandbox matches"}`))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	_, err := runRootCommandOutput(t, "send", "hi", "--rig", "dup", "--output", "json")
	if err == nil || !strings.Contains(err.Error(), `use "id=dup" or "name=dup"`) {
		t.Fatalf("error = %v, want a hint naming id=dup and name=dup", err)
	}
}

// TestRigReferenceParsedBeforeAuth checks that a malformed rig reference is
// reported as itself, not hidden behind a login prompt, for every command
// that names a rig, and that "_self" outside a rig names the variables to set.
// `rig ssh` reads its own argv, so it is covered in the sandbox package.
func TestRigReferenceParsedBeforeAuth(t *testing.T) {
	cases := []struct {
		args    []string
		wantErr string
	}{
		{[]string{"send", "hi", "--rig", "id="}, "no value"},
		{[]string{"rig", "agent-send", "name=", "hi"}, "no value"},
		{[]string{"service", "list", "--rig", "name="}, "no value"},
		{[]string{"service", "create", "--rig", "id=", "--name", "web", "--port", "3000", "--url-scheme", "https"}, "no value"},
		{[]string{"service", "delete", "--force", "--rig", "name=", "--name", "web"}, "no value"},
		{[]string{"snapshot", "create", "--rig", "id=", "--no-interactive", "--mode", "full", "--name", "snap"}, "no value"},
		{[]string{"snapshot", "list", "--rig", "id="}, "no value"},
		{[]string{"rig", "get", "id="}, "no value"},
		{[]string{"rig", "get", "_self"}, "AMIKA_RIG_NAME"},
		{[]string{"rig", "start", "box", "name="}, "no value"},
		{[]string{"rig", "stop", "id=_self"}, "not its id"},
		{[]string{"rig", "delete", "--force", "box", "id="}, "no value"},
		{[]string{"rig", "connect", "name="}, "no value"},
		{[]string{"rig", "open", "id="}, "no value"},
		{[]string{"rig", "bind", "id=", "gh-branch:o/r/b"}, "no value"},
		{[]string{"rig", "bindings", "list", "--rig", "id="}, "no value"},
		{[]string{"rig", "bindings", "delete", "--force", "name=", "gh-branch:o/r/b"}, "no value"},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			resetServiceFlags(t)
			t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
			t.Setenv("AMIKA_API_KEY", "")
			t.Setenv("AMIKA_API_URL", "http://127.0.0.1:1")
			t.Setenv("AMIKA_RIG_NAME", "")
			t.Setenv("AMIKA_SANDBOX_NAME", "")
			_, err := runRootCommandOutput(t, tc.args...)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}
}
