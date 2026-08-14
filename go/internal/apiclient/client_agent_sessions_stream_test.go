package apiclient

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sseServer returns a test server that replies to the send-stream endpoint with
// the given raw SSE body, recording the request method, path, and Accept header.
func sseServer(t *testing.T, body string, rec *struct {
	method, path, accept string
}) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.method, rec.path, rec.accept = r.Method, r.URL.Path, r.Header.Get("Accept")
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, body)
	}))
}

// TestSendAgentSessionStream_ForwardsFramesAndReturnsDone checks that status and
// delta frames are dispatched in order and the terminal done frame is parsed
// into the returned response.
func TestSendAgentSessionStream_ForwardsFramesAndReturnsDone(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := strings.Join([]string{
		"event: status\ndata: {\"phase\":\"creating_sandbox\"}\n\n",
		"event: status\ndata: {\"phase\":\"sandbox_ready\",\"sandbox_id\":\"sbx_1\"}\n\n",
		"event: delta\ndata: {\"text\":\"Hel\"}\n\n",
		"event: delta\ndata: {\"text\":\"lo\"}\n\n",
		"event: done\ndata: {\"session_id\":\"chat_1\",\"sandbox_id\":\"sbx_1\",\"agent\":\"claude\",\"response\":\"Hello\",\"is_error\":false,\"is_new_session\":true,\"created_sandbox\":true}\n\n",
	}, "")
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	var deltas strings.Builder
	var statuses []string
	c := NewClient(srv.URL, "test-token")
	resp, err := c.SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi", Agent: "claude"},
		AgentSessionStreamHandlers{
			OnStatus: func(phase, sandboxID string) {
				statuses = append(statuses, phase+":"+sandboxID)
			},
			OnDelta: func(text string) { deltas.WriteString(text) },
		},
	)
	if err != nil {
		t.Fatalf("SendAgentSessionStream: %v", err)
	}

	if rec.method != http.MethodPost ||
		rec.path != "/api/v0beta1/agent-sessions/stream" {
		t.Errorf("request = %s %s", rec.method, rec.path)
	}
	if rec.accept != "text/event-stream" {
		t.Errorf("Accept = %q, want text/event-stream", rec.accept)
	}
	if deltas.String() != "Hello" {
		t.Errorf("deltas = %q, want %q", deltas.String(), "Hello")
	}
	if len(statuses) != 2 ||
		statuses[0] != "creating_sandbox:" ||
		statuses[1] != "sandbox_ready:sbx_1" {
		t.Errorf("statuses = %v", statuses)
	}
	if resp.SessionID != "chat_1" || resp.Response != "Hello" ||
		!resp.IsNewSession || !resp.CreatedSandbox {
		t.Errorf("resp = %+v", resp)
	}
}

// TestSendAgentSessionStream_ErrorFrame checks a mid-stream error frame becomes
// a returned error carrying the frame's message.
func TestSendAgentSessionStream_ErrorFrame(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := "event: delta\ndata: {\"text\":\"partial\"}\n\n" +
		"event: error\ndata: {\"error\":\"sandbox blew up\"}\n\n"
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	_, err := c.SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{},
	)
	if err == nil || !strings.Contains(err.Error(), "sandbox blew up") {
		t.Fatalf("err = %v, want the error-frame message", err)
	}
}

// TestSendAgentSessionStream_NoDoneFrame checks that a stream ending without a
// done (or error) frame is reported rather than silently returning nil.
func TestSendAgentSessionStream_NoDoneFrame(t *testing.T) {
	var rec struct{ method, path, accept string }
	srv := sseServer(t, "event: delta\ndata: {\"text\":\"hi\"}\n\n", &rec)
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	_, err := c.SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{},
	)
	if err == nil || !strings.Contains(err.Error(), "without a result") {
		t.Fatalf("err = %v, want a no-result error", err)
	}
}

// TestSendAgentSessionStream_PreStreamHTTPError checks that a rejection before
// the stream opens (a normal JSON 4xx) surfaces as an error, not a parsed stream.
func TestSendAgentSessionStream_PreStreamHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"code":"validation_failed","message":"Agent session not found"}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	_, err := c.SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi", SessionID: "nope"},
		AgentSessionStreamHandlers{},
	)
	if err == nil || !strings.Contains(err.Error(), "Agent session not found") {
		t.Fatalf("err = %v, want the 404 message", err)
	}
}
