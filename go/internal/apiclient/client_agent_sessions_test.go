package apiclient

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestSendAgentSession_RequestAndResponse checks that SendAgentSession posts to
// the agent-sessions collection with the request body and parses the full
// AgentSessionSendResponse (including the optional cost_usd).
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
			"cost_usd":        0.5,
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
	if resp.CostUSD == nil || *resp.CostUSD != 0.5 {
		t.Errorf("CostUSD = %v, want 0.5", resp.CostUSD)
	}
}

// TestListAgentSessions_ParsesEnvelope checks the list method unwraps the
// {sessions,total} envelope and parses nullable sandbox_id/agent.
func TestListAgentSessions_ParsesEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v0beta1/agent-sessions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"sessions":[
          {"session_id":"chat_cnv_1","sandbox_id":"sbx_1","agent":"claude","status":"idle","last_error":null,"created_at":"t0","updated_at":"t1"},
          {"session_id":"chat_cnv_2","sandbox_id":null,"agent":null,"status":"idle","last_error":null,"created_at":"t0","updated_at":"t2"}
        ],"total":2}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	sessions, err := c.ListAgentSessions()
	if err != nil {
		t.Fatalf("ListAgentSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("len = %d, want 2", len(sessions))
	}
	if sessions[0].SandboxID == nil || *sessions[0].SandboxID != "sbx_1" {
		t.Errorf("sessions[0].SandboxID = %v", sessions[0].SandboxID)
	}
	if sessions[1].SandboxID != nil || sessions[1].Agent != nil {
		t.Errorf("sessions[1] should have null sandbox_id/agent: %+v", sessions[1])
	}
}

// TestGetAgentSession_EscapesIDAndParsesMessages checks the id is path-escaped
// and the message history is parsed.
func TestGetAgentSession_EscapesIDAndParsesMessages(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"session_id":"chat_cnv/1","sandbox_id":"sbx_1","agent":"claude","status":"idle","created_at":"t0","updated_at":"t1","messages":[
          {"id":"m1","direction":"inbound","author":"user","contents":"hi","is_error":false,"occurred_at":"t0"},
          {"id":"m2","direction":"outbound","author":"claude","contents":"hello","is_error":false,"occurred_at":"t1"}
        ]}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	detail, err := c.GetAgentSession("chat_cnv/1")
	if err != nil {
		t.Fatalf("GetAgentSession: %v", err)
	}
	if gotPath != "/api/v0beta1/agent-sessions/chat_cnv%2F1" {
		t.Errorf("path = %s, want the id path-escaped", gotPath)
	}
	if len(detail.Messages) != 2 {
		t.Fatalf("messages = %d, want 2", len(detail.Messages))
	}
	if detail.Messages[0].Direction != "inbound" || detail.Messages[1].Contents != "hello" {
		t.Errorf("messages = %+v", detail.Messages)
	}
}
