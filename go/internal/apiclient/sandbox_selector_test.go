package apiclient

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// recordRequests serves every request with a minimal sandbox-shaped JSON body
// and records each request's method and URI.
func recordRequests(t *testing.T) (*Client, *[]string) {
	t.Helper()
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Method+" "+r.RequestURI)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"sb_1","name":"box","state":"active"}`))
	}))
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, "test-token"), &got
}

// TestSandboxSelectorWire checks every sandbox-addressed route against a ref
// and a pinned selector: a ref selector leaves the request exactly as it was
// before selectors existed (no by/sandbox_by), and a pinned one adds `by`
// where the sandbox is the resource and `sandbox_by` where it is the parent.
func TestSandboxSelectorWire(t *testing.T) {
	svc := SandboxServiceRequest{Name: "web", Port: 3000, URLScheme: "https"}
	routes := []struct {
		name string
		call func(c *Client, sel SandboxSelector) error
		// want is the request URI for a ref selector; %s is where a pinned
		// selector's query goes, and wantPinned the parameter carrying it.
		want       string
		wantPinned string
	}{
		{"GetSandbox", func(c *Client, s SandboxSelector) error { _, err := c.GetSandbox(s); return err }, "GET /api/v0beta1/sandboxes/org%%2Fbox%s", "by"},
		{"DeleteSandbox", func(c *Client, s SandboxSelector) error { return c.DeleteSandbox(s) }, "DELETE /api/v0beta1/sandboxes/org%%2Fbox%s", "by"},
		{"StartSandbox", func(c *Client, s SandboxSelector) error { return c.StartSandbox(s) }, "POST /api/v0beta1/sandboxes/org%%2Fbox/start%s", "by"},
		{"StopSandbox", func(c *Client, s SandboxSelector) error { return c.StopSandbox(s) }, "POST /api/v0beta1/sandboxes/org%%2Fbox/stop%s", "by"},
		{"CreateSession", func(c *Client, s SandboxSelector) error {
			_, err := c.CreateSession(s, CreateSessionRequest{AgentName: "claude"})
			return err
		}, "POST /api/v0beta1/sandboxes/org%%2Fbox/sessions%s", "sandbox_by"},
		{"ListSessions", func(c *Client, s SandboxSelector) error { _, err := c.ListSessions(s); return err }, "GET /api/v0beta1/sandboxes/org%%2Fbox/sessions%s", "sandbox_by"},
		{"GetLatestSession", func(c *Client, s SandboxSelector) error { _, err := c.GetLatestSession(s); return err }, "GET /api/v0beta1/sandboxes/org%%2Fbox/sessions/latest%s", "sandbox_by"},
		{"GetSession", func(c *Client, s SandboxSelector) error { _, err := c.GetSession(s, "ses_1"); return err }, "GET /api/v0beta1/sandboxes/org%%2Fbox/sessions/ses_1%s", "sandbox_by"},
		{"UpdateSession", func(c *Client, s SandboxSelector) error {
			_, err := c.UpdateSession(s, "ses_1", UpdateSessionRequest{Status: "ended"})
			return err
		}, "PATCH /api/v0beta1/sandboxes/org%%2Fbox/sessions/ses_1%s", "sandbox_by"},
		{"CreateSandboxService", func(c *Client, s SandboxSelector) error { _, err := c.CreateSandboxService(s, svc); return err }, "POST /api/v0beta1/sandboxes/org%%2Fbox/services%s", "sandbox_by"},
	}
	c, got := recordRequests(t)
	for _, route := range routes {
		for _, tc := range []struct {
			sel   SandboxSelector
			query string
		}{
			{SandboxByRef("org/box"), ""},
			{SandboxByID("org/box"), "?" + route.wantPinned + "=id"},
		} {
			t.Run(route.name+"/"+tc.sel.kind(), func(t *testing.T) {
				*got = nil
				_ = route.call(c, tc.sel)
				want := []string{fmt.Sprintf(route.want, tc.query)}
				if !reflect.DeepEqual(*got, want) {
					t.Fatalf("requests = %q, want %q", *got, want)
				}
			})
		}
	}
}

// TestServiceRoutesKeepServiceBy checks that the service routes' bare `by`
// still names the service's kind, beside a sandbox_by for the sandbox.
func TestServiceRoutesKeepServiceBy(t *testing.T) {
	c, got := recordRequests(t)
	_, _ = c.PutSandboxService(SandboxSelector{Value: "sb_1", By: SelectByID}, "web", "", SandboxServiceRequest{Name: "web", Port: 1, URLScheme: "http"})
	_ = c.DeleteSandboxService(SandboxSelector{Value: "box", By: SelectByName}, "web")
	_ = c.DeleteSandboxService(SandboxByRef("box"), "web")
	want := []string{
		"PUT /api/v0beta1/sandboxes/sb_1/services/web?by=name&sandbox_by=id",
		"DELETE /api/v0beta1/sandboxes/box/services/web?by=name&sandbox_by=name",
		"DELETE /api/v0beta1/sandboxes/box/services/web?by=name",
	}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("requests = %q, want %q", *got, want)
	}
}

// TestRoutesThatAlwaysSendTheKind checks the routes that spell out the kind
// even for a ref selector: bindings (sandbox_by) and the scrub preview (by).
func TestRoutesThatAlwaysSendTheKind(t *testing.T) {
	c, got := recordRequests(t)
	_, _ = c.ListSandboxBindingsForSandbox(SandboxSelector{Value: "box"})
	_, _ = c.ListSandboxBindingsForSandbox(SandboxSelector{Value: "sb_1", By: SelectByID})
	_, _ = c.GetSandboxScrubPreview(SandboxSelector{Value: "box"})
	_, _ = c.GetSandboxScrubPreview(SandboxSelector{Value: "box", By: SelectByName})
	want := []string{
		"GET /api/v0beta1/sandboxes/box/bindings?sandbox_by=ref",
		"GET /api/v0beta1/sandboxes/sb_1/bindings?sandbox_by=id",
		"GET /api/v0beta1/sandbox-snapshots/scrub-preview?by=ref&sandbox=box",
		"GET /api/v0beta1/sandbox-snapshots/scrub-preview?by=name&sandbox=box",
	}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("requests = %q, want %q", *got, want)
	}
}

// TestCreateSSHSessionSelectsByID checks that an SSH session, always
// requested for a canonical id, pins sandbox_by=id, so a rig named after that
// id cannot make the request ambiguous.
func TestCreateSSHSessionSelectsByID(t *testing.T) {
	c, got := recordRequests(t)
	_, _ = c.CreateSSHSession("sbx_123")
	if want := []string{"POST /api/v0beta1/sandboxes/sbx_123/ssh-sessions?sandbox_by=id"}; !reflect.DeepEqual(*got, want) {
		t.Fatalf("requests = %q, want %q", *got, want)
	}
}

// TestListSandboxSnapshotsSourceFilter checks that the source sandbox filter
// is the query parameter its selector's kind names, and absent for a zero
// selector.
func TestListSandboxSnapshotsSourceFilter(t *testing.T) {
	c, got := recordRequests(t)
	for _, sel := range []SandboxSelector{{}, {Value: "box"}, SandboxByRef("box"), {Value: "box", By: SelectByName}, {Value: "sb_1", By: SelectByID}} {
		_, _ = c.ListSandboxSnapshots("", sel)
	}
	want := []string{
		"GET /api/v0beta1/sandbox-snapshots",
		"GET /api/v0beta1/sandbox-snapshots?source_sandbox_ref=box",
		"GET /api/v0beta1/sandbox-snapshots?source_sandbox_ref=box",
		"GET /api/v0beta1/sandbox-snapshots?source_sandbox_name=box",
		"GET /api/v0beta1/sandbox-snapshots?source_sandbox_id=sb_1",
	}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("requests = %q, want %q", *got, want)
	}
}

// bodyFields encodes v and returns its top-level JSON object.
func bodyFields(t *testing.T, v any) map[string]any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}

// TestCreateSandboxSnapshotRequestSetSandbox checks that the snapshot body
// carries exactly one source field, the one the selector's kind names.
func TestCreateSandboxSnapshotRequestSetSandbox(t *testing.T) {
	for _, tc := range []struct {
		sel  SandboxSelector
		want map[string]any
	}{
		{SandboxByRef("box"), map[string]any{"sandbox_ref": "box", "name": "snap"}},
		{SandboxSelector{Value: "box", By: SelectByName}, map[string]any{"sandbox_name": "box", "name": "snap"}},
		{SandboxSelector{Value: "sb_1", By: SelectByID}, map[string]any{"sandbox_id": "sb_1", "name": "snap"}},
	} {
		req := CreateSandboxSnapshotRequest{SandboxRef: "stale", Name: "snap"}
		req.SetSandbox(tc.sel)
		if got := bodyFields(t, req); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("SetSandbox(%+v) body = %v, want %v", tc.sel, got, tc.want)
		}
	}
}

// TestAgentSessionSendRequestSetSandbox checks that the send body carries
// exactly one routing field, the one the selector's kind names: sandbox_ref
// for a ref (or kindless) selector, sandbox_name for a name selector, and
// sandbox_id for an id selector.
func TestAgentSessionSendRequestSetSandbox(t *testing.T) {
	for _, tc := range []struct {
		sel  SandboxSelector
		want map[string]any
	}{
		{SandboxSelector{Value: "box"}, map[string]any{"message": "hi", "sandbox_ref": "box"}},
		{SandboxByRef("box"), map[string]any{"message": "hi", "sandbox_ref": "box"}},
		{SandboxSelector{Value: "box", By: SelectByName}, map[string]any{"message": "hi", "sandbox_name": "box"}},
		{SandboxSelector{Value: "sb_1", By: SelectByID}, map[string]any{"message": "hi", "sandbox_id": "sb_1"}},
	} {
		req := AgentSessionSendRequest{Message: "hi", SandboxRef: "stale", SandboxName: "stale", SandboxID: "stale"}
		req.SetSandbox(tc.sel)
		if got := bodyFields(t, req); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("SetSandbox(%+v) body = %v, want %v", tc.sel, got, tc.want)
		}
	}
}

// TestIsResourceRefAmbiguous checks that only the API's 409
// resource_ref_ambiguous, however deeply wrapped, counts as an ambiguous
// reference.
func TestIsResourceRefAmbiguous(t *testing.T) {
	ambiguous := &HTTPError{StatusCode: 409, Body: `{"code":"resource_ref_ambiguous","message":"two sandboxes match"}`}
	if !IsResourceRefAmbiguous(fmt.Errorf("remote get sandbox: %w", ambiguous)) {
		t.Error("wrapped 409 resource_ref_ambiguous not recognized")
	}
	legacyCode := &HTTPError{StatusCode: 409, Body: `{"error_code":"resource_ref_ambiguous","message":"two sandboxes match"}`}
	if !IsResourceRefAmbiguous(legacyCode) {
		t.Error("error_code spelling not recognized")
	}
	for _, err := range []error{
		nil,
		&HTTPError{StatusCode: 409, Body: `{"code":"conflict","message":"busy"}`},
		&HTTPError{StatusCode: 404, Body: `{"code":"resource_ref_ambiguous","message":"x"}`},
		&HTTPError{StatusCode: 409, Body: `not json`},
	} {
		if IsResourceRefAmbiguous(err) {
			t.Errorf("IsResourceRefAmbiguous(%v) = true, want false", err)
		}
	}
}
