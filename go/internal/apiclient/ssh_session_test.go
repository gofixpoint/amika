package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateSSHSessionPostsForEveryDial(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/api/v0beta1/sandboxes/sbx_123/ssh-sessions" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer api-token" {
			t.Errorf("Authorization = %q", got)
		}
		_ = json.NewEncoder(w).Encode(SSHSession{
			SessionID:         "sshs_1",
			Transport:         "direct_ws",
			ConnectURL:        "wss://sandbox.example/v1/ssh-sessions",
			ConnectCredential: "connect-token",
			SandboxID:         "sbx_123",
			SSHUser:           "amika",
			HostPublicKey:     "ssh-ed25519 AAAAtest",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "api-token")
	for range 2 {
		session, err := client.CreateSSHSession("sbx_123")
		if err != nil {
			t.Fatalf("CreateSSHSession: %v", err)
		}
		if session.SessionID != "sshs_1" || session.Transport != "direct_ws" {
			t.Fatalf("session = %#v", session)
		}
	}
	if calls != 2 {
		t.Fatalf("API calls = %d, want 2", calls)
	}
}
