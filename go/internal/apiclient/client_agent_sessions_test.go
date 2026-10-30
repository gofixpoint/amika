package apiclient

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestSendAgentSession_RequestAndResponse checks that SendAgentSession posts to
// the agent-sessions collection with the request body and parses the full
// AgentSessionSendResponse (including the optional nested usage).
func TestSendAgentSession_RequestAndResponse(t *testing.T) {
	var gotMethod, gotPath string
	var gotReq AgentSessionSendRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &gotReq)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"session_id":      "chat_cnv_1",
			"sandbox_id":      "sbx_1",
			"agent":           "codex",
			"response":        "hello there",
			"is_error":        false,
			"is_new_session":  true,
			"created_sandbox": true,
			"usage": map[string]any{
				"cost_usd":      0.5,
				"input_tokens":  120,
				"output_tokens": 45,
			},
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	resp, err := c.SendAgentSession(AgentSessionSendRequest{
		Message:   "hi",
		Agent:     "codex",
		SessionID: "chat_cnv_1",
	})
	if err != nil {
		t.Fatalf("SendAgentSession: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/v0beta1/agent-sessions" {
		t.Errorf("request = %s %s", gotMethod, gotPath)
	}
	if gotReq.Message != "hi" || gotReq.Agent != "codex" || gotReq.SessionID != "chat_cnv_1" {
		t.Errorf("request body = %+v", gotReq)
	}
	if resp.SessionID != "chat_cnv_1" || resp.SandboxID != "sbx_1" || resp.Agent != "codex" {
		t.Errorf("resp = %+v", resp)
	}
	if resp.Response != "hello there" || !resp.IsNewSession || !resp.CreatedSandbox {
		t.Errorf("resp = %+v", resp)
	}
	if resp.Usage == nil {
		t.Fatalf("Usage = nil, want the nested usage object")
	}
	if resp.Usage.CostUSD == nil || *resp.Usage.CostUSD != 0.5 {
		t.Errorf("Usage.CostUSD = %v, want 0.5", resp.Usage.CostUSD)
	}
	if resp.Usage.InputTokens == nil || *resp.Usage.InputTokens != 120 {
		t.Errorf("Usage.InputTokens = %v, want 120", resp.Usage.InputTokens)
	}
	// A field the provider didn't report stays absent rather than becoming 0.
	if resp.Usage.NumTurns != nil {
		t.Errorf("Usage.NumTurns = %v, want nil", resp.Usage.NumTurns)
	}
}

// TestSendAgentSession_OmitsUsageWhenAbsent checks a response without `usage`
// (a provider that reports no accounting, e.g. codex) parses to a nil Usage
// that is dropped again when the response is re-emitted under `--output json`.
func TestSendAgentSession_OmitsUsageWhenAbsent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"session_id":"chat_1","sandbox_id":"sbx_1","agent":"codex",
          "response":"ok","is_error":false,"is_new_session":false,"created_sandbox":false}`)
	}))
	defer srv.Close()

	resp, err := NewClient(srv.URL, "test-token").SendAgentSession(
		AgentSessionSendRequest{Message: "hi"},
	)
	if err != nil {
		t.Fatalf("SendAgentSession: %v", err)
	}
	if resp.Usage != nil {
		t.Errorf("Usage = %+v, want nil", resp.Usage)
	}
	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "usage") {
		t.Errorf("re-emitted JSON = %s, want no usage key", out)
	}
}

// TestListAgentSessions_ParsesEnvelope checks the list method unwraps the
// {sessions,total} envelope and parses the nullable sandbox_name/preview/
// model/effort/ended_at fields.
func TestListAgentSessions_ParsesEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v0beta1/agent-sessions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"sessions":[
          {"session_id":"as_1","sandbox_id":"sbx_1","sandbox_name":"silver-wuhan","agent":"claude",
           "status":"active","preview":"hi there","model":"opus","effort":"high",
           "started_at":"t0","ended_at":null,
           "created_at":"t0","updated_at":"t1"},
          {"session_id":"as_2","sandbox_id":"sbx_2","sandbox_name":null,"agent":"codex",
           "status":"ended","preview":null,"model":null,"effort":null,
           "started_at":"t0","ended_at":"t2",
           "created_at":"t0","updated_at":"t2"}
        ],"total":2}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	resp, err := c.ListAgentSessions(0)
	if err != nil {
		t.Fatalf("ListAgentSessions: %v", err)
	}
	sessions := resp.Sessions
	if len(sessions) != 2 {
		t.Fatalf("len = %d, want 2", len(sessions))
	}
	if resp.Total != 2 {
		t.Errorf("total = %d, want 2", resp.Total)
	}
	if sessions[0].SandboxID != "sbx_1" || sessions[0].Agent != "claude" {
		t.Errorf("sessions[0] = %+v", sessions[0])
	}
	if sessions[0].SandboxName == nil || *sessions[0].SandboxName != "silver-wuhan" {
		t.Errorf("sessions[0].SandboxName = %v", sessions[0].SandboxName)
	}
	if sessions[0].Preview == nil || *sessions[0].Preview != "hi there" {
		t.Errorf("sessions[0].Preview = %v", sessions[0].Preview)
	}
	if sessions[0].Model == nil || *sessions[0].Model != "opus" {
		t.Errorf("sessions[0].Model = %v", sessions[0].Model)
	}
	if sessions[0].Effort == nil || *sessions[0].Effort != "high" {
		t.Errorf("sessions[0].Effort = %v", sessions[0].Effort)
	}
	if sessions[0].EndedAt != nil {
		t.Errorf("sessions[0].EndedAt = %v, want nil", sessions[0].EndedAt)
	}
	if sessions[1].SandboxName != nil || sessions[1].Preview != nil {
		t.Errorf("sessions[1] should have null sandbox_name/preview: %+v", sessions[1])
	}
	// Null means the agent CLI's own default, which is a different fact from
	// the field being absent; both must survive as a nil pointer.
	if sessions[1].Model != nil || sessions[1].Effort != nil {
		t.Errorf("sessions[1] should have null model/effort: %+v", sessions[1])
	}
	if sessions[1].EndedAt == nil || *sessions[1].EndedAt != "t2" {
		t.Errorf("sessions[1].EndedAt = %v, want t2", sessions[1].EndedAt)
	}
}

// TestGetAgentSession_EscapesIDAndParsesMessages checks the id is path-escaped
// and the transcript is parsed in the API's {role,content,timestamp} shape,
// including the optional per-turn is_error flag.
func TestGetAgentSession_EscapesIDAndParsesMessages(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"session_id":"as/1","sandbox_id":"sbx_1","sandbox_name":"silver-wuhan",
          "agent":"claude","status":"active","preview":null,"started_at":"t0","ended_at":null,
          "created_at":"t0","updated_at":"t1","messages":[
          {"role":"user","content":"hi","timestamp":"t0"},
          {"role":"assistant","content":"hello","timestamp":"t1","is_error":false},
          {"role":"assistant","content":"Not logged in","timestamp":"t2","is_error":true}
        ]}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	detail, err := c.GetAgentSession("as/1")
	if err != nil {
		t.Fatalf("GetAgentSession: %v", err)
	}
	if gotPath != "/api/v0beta1/agent-sessions/as%2F1" {
		t.Errorf("path = %s, want the id path-escaped", gotPath)
	}
	// The detail embeds the summary, so its fields parse from the same object.
	if detail.SessionID != "as/1" || detail.Agent != "claude" || detail.Status != "active" {
		t.Errorf("detail = %+v", detail.AgentSessionSummary)
	}
	if detail.SandboxName == nil || *detail.SandboxName != "silver-wuhan" {
		t.Errorf("detail.SandboxName = %v", detail.SandboxName)
	}
	if len(detail.Messages) != 3 {
		t.Fatalf("messages = %d, want 3", len(detail.Messages))
	}
	if detail.Messages[0].Role != "user" || detail.Messages[0].Content != "hi" ||
		detail.Messages[0].Timestamp != "t0" {
		t.Errorf("messages[0] = %+v", detail.Messages[0])
	}
	// Absent on a user turn, explicitly false on a successful assistant turn,
	// true on a failed one — three states the pointer must keep distinct so
	// `--output json` re-emits what the API actually sent.
	if detail.Messages[0].IsError != nil {
		t.Errorf("messages[0].IsError = %v, want nil (absent)", *detail.Messages[0].IsError)
	}
	if detail.Messages[1].IsError == nil || *detail.Messages[1].IsError {
		t.Errorf("messages[1].IsError = %v, want an explicit false", detail.Messages[1].IsError)
	}
	if detail.Messages[2].IsError == nil || !*detail.Messages[2].IsError {
		t.Errorf("messages[2].IsError = %v, want true", detail.Messages[2].IsError)
	}
	// An explicit false must survive the round trip, not vanish via omitempty.
	out, err := json.Marshal(detail.Messages[1])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"is_error":false`) {
		t.Errorf("re-emitted message = %s, want an explicit is_error:false", out)
	}
}

// TestListAgentSessions_ReEmitsEnvelope checks the response round-trips as the
// API's {sessions,total} envelope, which `sessions list -o json` emits verbatim
// (remote-backed commands mirror the API response schema). An empty page must
// encode as [] rather than null.
func TestListAgentSessions_ReEmitsEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"sessions":[],"total":7}`)
	}))
	defer srv.Close()

	resp, err := NewClient(srv.URL, "test-token").ListAgentSessions(0)
	if err != nil {
		t.Fatalf("ListAgentSessions: %v", err)
	}
	if resp.Total != 7 {
		t.Errorf("total = %d, want 7", resp.Total)
	}
	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(out) != `{"sessions":[],"total":7}` {
		t.Errorf("re-emitted = %s, want the {sessions,total} envelope with []", out)
	}
}

// TestListAgentSessions_ReEmitsEveryRequiredKey pins the summary's re-emitted
// shape against the response schema's required property list. `sessions list
// -o json` re-encodes what it decoded, so a field the struct has no home for is
// dropped silently: the CLI parses 12 keys and prints 10, and nothing fails
// until an e2e schema assertion happens to cover it. Asserting the key set (not
// just the values) is what catches that, since a dropped key leaves every
// remaining assertion passing.
func TestListAgentSessions_ReEmitsEveryRequiredKey(t *testing.T) {
	// The 12 properties AgentSessionSummary marks required. A nullable field is
	// still required: the key is always present and may be null.
	required := []string{
		"session_id", "sandbox_id", "sandbox_name", "agent", "status",
		"preview", "model", "effort", "started_at", "ended_at",
		"created_at", "updated_at",
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"sessions":[
          {"session_id":"as_1","sandbox_id":"sbx_1","sandbox_name":null,"agent":"claude",
           "status":"active","preview":null,"model":null,"effort":null,
           "started_at":"t0","ended_at":null,"created_at":"t0","updated_at":"t1"}
        ],"total":1}`)
	}))
	defer srv.Close()

	resp, err := NewClient(srv.URL, "test-token").ListAgentSessions(0)
	if err != nil {
		t.Fatalf("ListAgentSessions: %v", err)
	}
	out, err := json.Marshal(resp.Sessions[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("unmarshal re-emitted: %v", err)
	}
	for _, k := range required {
		if _, ok := got[k]; !ok {
			t.Errorf("re-emitted summary drops required key %q: %s", k, out)
		}
	}
	if len(got) != len(required) {
		t.Errorf("re-emitted %d keys, want %d: %s", len(got), len(required), out)
	}
}

// TestListAgentSessions_SendsLimit checks a non-zero limit reaches the query
// string and zero leaves the server's default page size in place.
func TestListAgentSessions_SendsLimit(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"sessions":[],"total":0}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	if _, err := c.ListAgentSessions(5); err != nil {
		t.Fatalf("ListAgentSessions(5): %v", err)
	}
	if gotQuery != "limit=5" {
		t.Errorf("query = %q, want limit=5", gotQuery)
	}
	if _, err := c.ListAgentSessions(0); err != nil {
		t.Fatalf("ListAgentSessions(0): %v", err)
	}
	if gotQuery != "" {
		t.Errorf("query = %q, want no limit param", gotQuery)
	}
}
