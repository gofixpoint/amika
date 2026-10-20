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

// TestSendRigReferenceKinds checks the send body's routing field per
// reference kind. Every kind ends up in the legacy sandbox_id, the one field
// a server that predates sandbox_name and sandbox_ref honors (it strips the
// others and would create a new sandbox). A bare value, ref= and _self go out
// as written; name= and id= are resolved to the rig's canonical id first.
func TestSendRigReferenceKinds(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantGet string
		want    map[string]any
	}{
		{"bare", []string{"send", "hi", "--rig", "my-rig"}, "", map[string]any{"sandbox_id": "my-rig"}},
		{"ref=", []string{"send", "hi", "--rig", "ref=my-rig"}, "", map[string]any{"sandbox_id": "my-rig"}},
		{"_self", []string{"send", "hi", "--rig", "_self"}, "", map[string]any{"sandbox_id": "here"}},
		{"name=", []string{"send", "hi", "--rig", "name=my-rig"}, "/api/v0beta1/sandboxes/my-rig?by=name", map[string]any{"sandbox_id": "sb_1"}},
		{"id=", []string{"send", "hi", "--rig", "id=sb_1"}, "/api/v0beta1/sandboxes/sb_1?by=id", map[string]any{"sandbox_id": "sb_1"}},
		{"agent-send name=", []string{"rig", "agent-send", "name=my-rig", "hi"}, "/api/v0beta1/sandboxes/my-rig?by=name", map[string]any{"sandbox_id": "sb_1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			var gets []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodGet {
					gets = append(gets, r.URL.RequestURI())
					_, _ = w.Write([]byte(`{"id":"sb_1","name":"my-rig","state":"running"}`))
					return
				}
				if r.URL.Path != "/api/v0beta1/agent-sessions" {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
				}
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
			var wantGets []string
			if tc.wantGet != "" {
				wantGets = []string{tc.wantGet}
			}
			if !reflect.DeepEqual(gets, wantGets) {
				t.Fatalf("lookups = %q, want %q", gets, wantGets)
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

// A server that predates the `by` selector ignores it and matches id or
// name, so `send --rig id=x` could land in the rig *named* x. The lookup's
// answer is checked against the pinned field, and nothing is sent when it
// does not match.
func TestSendPinnedRigRefusesAMismatchedRig(t *testing.T) {
	sent := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			// Matched by name, as an old server would.
			_, _ = w.Write([]byte(`{"id":"sb_9","name":"my-rig","state":"running"}`))
			return
		}
		sent = true
	}))
	defer server.Close()
	t.Setenv("AMIKA_API_URL", server.URL)
	t.Setenv("AMIKA_API_KEY", "test-key")

	_, err := runRootCommandOutput(t, "send", "hi", "--rig", "id=my-rig", "--output", "json")
	if err == nil || !strings.Contains(err.Error(), `no rig has id "my-rig"`) {
		t.Fatalf("error = %v, want the id mismatch", err)
	}
	if sent {
		t.Fatal("the message was sent to a rig the reference does not name")
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
