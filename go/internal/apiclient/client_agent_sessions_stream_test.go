package apiclient

import (
	"encoding/json"
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

// TestSendAgentSessionStream_EventlessDataFrameDoesNotCorruptNext checks that a
// frame carrying data but no `event:` line (a legal SSE `message` event, and a
// common keepalive idiom) is discarded cleanly. Its payload must not survive in
// the buffer to be glued onto the front of the following frame, which would
// fail a send whose turn had already completed and been persisted.
func TestSendAgentSessionStream_EventlessDataFrameDoesNotCorruptNext(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := "data: {\"stray\":1}\n\n" +
		"event: done\ndata: {\"session_id\":\"chat_1\",\"sandbox_id\":\"sbx_1\"," +
		"\"agent\":\"claude\",\"response\":\"ok\",\"is_error\":false," +
		"\"is_new_session\":true,\"created_sandbox\":false}\n\n"
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	resp, err := NewClient(srv.URL, "test-token").SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{},
	)
	if err != nil {
		t.Fatalf("SendAgentSessionStream: %v", err)
	}
	if resp.SessionID != "chat_1" || resp.Response != "ok" {
		t.Errorf("resp = %+v", resp)
	}
}

// TestSendAgentSessionStream_MalformedDeltaIsAnError checks that an unparseable
// delta fails the send rather than being dropped. Silently skipping it would
// print a truncated reply and still exit 0.
func TestSendAgentSessionStream_MalformedDeltaIsAnError(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := "event: delta\ndata: {\"text\":\"good\"}\n\n" +
		"event: delta\ndata: not-json\n\n" +
		"event: done\ndata: {\"session_id\":\"chat_1\",\"sandbox_id\":\"sbx_1\"," +
		"\"agent\":\"claude\",\"response\":\"goodLOST\",\"is_error\":false," +
		"\"is_new_session\":true,\"created_sandbox\":false}\n\n"
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	_, err := NewClient(srv.URL, "test-token").SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{OnDelta: func(string) {}},
	)
	if err == nil || !strings.Contains(err.Error(), "parsing delta frame") {
		t.Fatalf("err = %v, want a delta parse error", err)
	}
}

// TestSendAgentSessionStream_DataWithoutSpace checks the optional space after
// `data:` is not required, per the SSE spec.
func TestSendAgentSessionStream_DataWithoutSpace(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := "event:delta\ndata:{\"text\":\"hi\"}\n\n" +
		"event:done\ndata:{\"session_id\":\"chat_1\",\"sandbox_id\":\"sbx_1\"," +
		"\"agent\":\"claude\",\"response\":\"hi\",\"is_error\":false," +
		"\"is_new_session\":true,\"created_sandbox\":false}\n\n"
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	var deltas strings.Builder
	resp, err := NewClient(srv.URL, "test-token").SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{OnDelta: func(s string) { deltas.WriteString(s) }},
	)
	if err != nil {
		t.Fatalf("SendAgentSessionStream: %v", err)
	}
	if deltas.String() != "hi" || resp.SessionID != "chat_1" {
		t.Errorf("deltas = %q, resp = %+v", deltas.String(), resp)
	}
}

// TestSendAgentSessionStream_DoneWinsOverLaterErrorFrame checks that a
// completed turn's result is returned even if an error frame follows: `done`
// is terminal, and discarding it would throw away a real session id.
func TestSendAgentSessionStream_DoneWinsOverLaterErrorFrame(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := "event: done\ndata: {\"session_id\":\"chat_1\",\"sandbox_id\":\"sbx_1\"," +
		"\"agent\":\"claude\",\"response\":\"ok\",\"is_error\":false," +
		"\"is_new_session\":true,\"created_sandbox\":false}\n\n" +
		"event: error\ndata: {\"error\":\"late failure\"}\n\n"
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	resp, err := NewClient(srv.URL, "test-token").SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{},
	)
	if err != nil {
		t.Fatalf("SendAgentSessionStream: %v", err)
	}
	if resp.SessionID != "chat_1" {
		t.Errorf("resp = %+v", resp)
	}
}

// TestSendAgentSessionStream_LargeResponse checks a response well past the old
// 4 MiB scanner cap parses, so a large-but-valid turn does not fail after it
// has already run and been billed.
func TestSendAgentSessionStream_LargeResponse(t *testing.T) {
	var rec struct{ method, path, accept string }
	big := strings.Repeat("x", 8*1024*1024)
	done, err := json.Marshal(AgentSessionSendResponse{
		SessionID: "chat_1", SandboxID: "sbx_1", Agent: "claude", Response: big,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	srv := sseServer(t, "event: done\ndata: "+string(done)+"\n\n", &rec)
	defer srv.Close()

	resp, err := NewClient(srv.URL, "test-token").SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{},
	)
	if err != nil {
		t.Fatalf("SendAgentSessionStream: %v", err)
	}
	if len(resp.Response) != len(big) {
		t.Errorf("response len = %d, want %d", len(resp.Response), len(big))
	}
}

// TestSendAgentSessionStream_CRLFAndHeartbeats checks CRLF framing and `:`
// comment keepalives, which the server emits to hold an idle connection open.
func TestSendAgentSessionStream_CRLFAndHeartbeats(t *testing.T) {
	var rec struct{ method, path, accept string }
	body := ": heartbeat\r\n\r\n" +
		"event: delta\r\ndata: {\"text\":\"hi\"}\r\n\r\n" +
		": heartbeat\r\n\r\n" +
		"event: done\r\ndata: {\"session_id\":\"chat_1\",\"sandbox_id\":\"sbx_1\"," +
		"\"agent\":\"claude\",\"response\":\"hi\",\"is_error\":false," +
		"\"is_new_session\":true,\"created_sandbox\":false}\r\n\r\n"
	srv := sseServer(t, body, &rec)
	defer srv.Close()

	var deltas strings.Builder
	resp, err := NewClient(srv.URL, "test-token").SendAgentSessionStream(
		AgentSessionSendRequest{Message: "hi"},
		AgentSessionStreamHandlers{OnDelta: func(s string) { deltas.WriteString(s) }},
	)
	if err != nil {
		t.Fatalf("SendAgentSessionStream: %v", err)
	}
	if deltas.String() != "hi" || resp.SessionID != "chat_1" {
		t.Errorf("deltas = %q, resp = %+v", deltas.String(), resp)
	}
}
