package main

// rigref_commands_test.go covers the rig references `send --rig`,
// `agent-send <rig>`, and `service create|delete --rig` accept, and what each
// reference kind puts on the wire.

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
// calls for: a bare value, ref=, and _self go in sandbox_ref (the server
// resolves an id or a name and refuses an ambiguous value), name= in
// sandbox_name, and id= in sandbox_id.
func TestSendRigReferenceKinds(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want map[string]any
	}{
		{"bare", []string{"send", "hi", "--rig", "my-rig"}, map[string]any{"sandbox_ref": "my-rig"}},
		{"ref=", []string{"send", "hi", "--rig", "ref=my-rig"}, map[string]any{"sandbox_ref": "my-rig"}},
		{"_self", []string{"send", "hi", "--rig", "_self"}, map[string]any{"sandbox_ref": "here"}},
		{"name=", []string{"send", "hi", "--rig", "name=my-rig"}, map[string]any{"sandbox_name": "my-rig"}},
		{"name=_self", []string{"send", "hi", "--rig", "name=_self"}, map[string]any{"sandbox_name": "here"}},
		{"id=", []string{"send", "hi", "--rig", "id=sb_1"}, map[string]any{"sandbox_id": "sb_1"}},
		{"agent-send bare", []string{"rig", "agent-send", "my-rig", "hi"}, map[string]any{"sandbox_ref": "my-rig"}},
		{"agent-send name=", []string{"rig", "agent-send", "name=my-rig", "hi"}, map[string]any{"sandbox_name": "my-rig"}},
		{"agent-send id=", []string{"rig", "agent-send", "id=sb_1", "hi"}, map[string]any{"sandbox_id": "sb_1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
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
			t.Setenv("AMIKA_RIG_NAME", "here")

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

// TestServiceRigReferenceKinds checks that service create and delete address
// the rig with sandbox_by only for an explicit name= or id=, beside the
// service routes' own `by` for the service.
func TestServiceRigReferenceKinds(t *testing.T) {
	const base = "/api/v0beta1/sandboxes/"
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"create bare", []string{"service", "create", "--rig", "box", "--name", "web", "--port", "3000", "--url-scheme", "https"}, "POST " + base + "box/services"},
		{"create name=", []string{"service", "create", "--rig", "name=box", "--name", "web", "--port", "3000", "--url-scheme", "https"}, "POST " + base + "box/services?sandbox_by=name"},
		{"delete bare", []string{"service", "delete", "--force", "--rig", "box", "--name", "web"}, "DELETE " + base + "box/services/web?by=name"},
		{"delete id=", []string{"service", "delete", "--force", "--rig", "id=sb_1", "--name", "web"}, "DELETE " + base + "sb_1/services/web?by=name&sandbox_by=id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetServiceFlags(t)
			var requests []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests = append(requests, r.Method+" "+r.RequestURI)
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodDelete {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				_, _ = w.Write([]byte(`{"sandbox_id":"sb_1","name":"web","port":3000,"protocol":"tcp","source":"table","kind":"user"}`))
			}))
			defer server.Close()
			t.Setenv("AMIKA_API_URL", server.URL)
			t.Setenv("AMIKA_API_KEY", "test-key")

			if out, err := runRootCommandOutput(t, tc.args...); err != nil {
				t.Fatalf("%v: %v\n%s", tc.args, err, out)
			}
			if want := []string{tc.want}; !reflect.DeepEqual(requests, want) {
				t.Fatalf("requests = %q, want %q", requests, want)
			}
		})
	}
}

func TestServiceDeleteAmbiguousRigSuggestsPrefixes(t *testing.T) {
	resetServiceFlags(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"resource_ref_ambiguous","message":"more than one sandbox matches"}`))
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	_, err := runRootCommandOutput(t, "service", "delete", "--force", "--rig", "dup", "--name", "web")
	if err == nil || !strings.Contains(err.Error(), `use "id=dup" or "name=dup"`) {
		t.Fatalf("error = %v, want a hint naming id=dup and name=dup", err)
	}
}

// TestRigFlagParsedBeforeAuth checks that a malformed --rig reference is
// reported as itself rather than behind a login prompt.
func TestRigFlagParsedBeforeAuth(t *testing.T) {
	for _, args := range [][]string{
		{"send", "hi", "--rig", "id="},
		{"rig", "agent-send", "name=", "hi"},
		{"service", "create", "--rig", "id=", "--name", "web", "--port", "3000", "--url-scheme", "https"},
		{"service", "delete", "--force", "--rig", "name=", "--name", "web"},
		{"snapshot", "create", "--rig", "id=", "--no-interactive", "--mode", "full", "--name", "snap"},
		{"snapshot", "list", "--rig", "id="},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			resetServiceFlags(t)
			t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
			t.Setenv("AMIKA_API_KEY", "")
			t.Setenv("AMIKA_API_URL", "http://127.0.0.1:1")
			_, err := runRootCommandOutput(t, args...)
			if err == nil || !strings.Contains(err.Error(), "no value") {
				t.Fatalf("error = %v, want a missing-value error", err)
			}
		})
	}
}
