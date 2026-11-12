package apiclient

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	cryptossh "golang.org/x/crypto/ssh"
)

func testEd25519PublicKey(t *testing.T) string {
	t.Helper()
	privateKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	publicKey, err := cryptossh.NewPublicKey(privateKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	return string(cryptossh.MarshalAuthorizedKey(publicKey))
}

func TestCreateSSHSessionPostsForEveryDial(t *testing.T) {
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	key := testEd25519PublicKey(t)
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
			Transport:         SSHSessionTransportDirectWS,
			ConnectURL:        "wss://sandbox.example/v1/ssh-sessions",
			ConnectCredential: token,
			SandboxID:         "sbx_123",
			SSHUser:           "amika",
			HostPublicKey:     key,
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "api-token")
	for range 2 {
		session, err := client.CreateSSHSession("sbx_123", nil)
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

func TestSSHSessionValidateAcceptsOnlyMatchingDirectWSSession(t *testing.T) {
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	key := testEd25519PublicKey(t)
	valid := SSHSession{
		SessionID:         "sshs_1",
		Transport:         SSHSessionTransportDirectWS,
		ConnectURL:        "wss://sandbox.example/v1/ssh-sessions",
		ConnectCredential: token,
		SandboxID:         "sbx_123",
		SSHUser:           "amika",
		HostPublicKey:     key,
	}
	if err := valid.Validate("sbx_123"); err != nil {
		t.Fatalf("Validate valid session: %v", err)
	}
	bareMetal := valid
	bareMetal.SSHUser = "Jakub.Smith"
	if err := bareMetal.Validate("sbx_123"); err != nil {
		t.Fatalf("Validate bare-metal session user: %v", err)
	}

	tests := map[string]SSHSession{
		"unknown transport": func() SSHSession { s := valid; s.Transport = "other"; return s }(),
		"wrong sandbox":     func() SSHSession { s := valid; s.SandboxID = "sbx_other"; return s }(),
		"non-wss URL":       func() SSHSession { s := valid; s.ConnectURL = "https://sandbox.example/v1/ssh-sessions"; return s }(),
		"URL credential": func() SSHSession {
			s := valid
			s.ConnectURL = "wss://user:secret@sandbox.example/v1/ssh-sessions"
			return s
		}(),
		"URL query": func() SSHSession {
			s := valid
			s.ConnectURL = "wss://sandbox.example/v1/ssh-sessions?token=secret"
			return s
		}(),
		"wrong URL path":        func() SSHSession { s := valid; s.ConnectURL = "wss://sandbox.example/other"; return s }(),
		"empty credential":      func() SSHSession { s := valid; s.ConnectCredential = ""; return s }(),
		"invalid host key":      func() SSHSession { s := valid; s.HostPublicKey = "ssh-rsa AAAA"; return s }(),
		"host key with newline": func() SSHSession { s := valid; s.HostPublicKey = "ssh-ed25519 AAAA\nInjected"; return s }(),
		"empty SSH user":        func() SSHSession { s := valid; s.SSHUser = ""; return s }(),
		"unsafe SSH user":       func() SSHSession { s := valid; s.SSHUser = "root@evil"; return s }(),
	}
	for name, session := range tests {
		t.Run(name, func(t *testing.T) {
			if err := session.Validate("sbx_123"); err == nil {
				t.Fatal("Validate returned nil")
			}
		})
	}
}

func TestSSHSessionResumeSwitchDefaultsOn(t *testing.T) {
	for body, want := range map[string]bool{
		`{}`:                   true,
		`{"ssh_resume":true}`:  true,
		`{"ssh_resume":false}`: false,
	} {
		var session SSHSession
		if err := json.Unmarshal([]byte(body), &session); err != nil {
			t.Fatal(err)
		}
		if got := session.ResumeEnabled(); got != want {
			t.Errorf("%s: ResumeEnabled = %v, want %v", body, got, want)
		}
	}
}

func validIrohSession(t *testing.T) SSHSession {
	t.Helper()
	relay := "https://relay.example"
	return SSHSession{
		SessionID:         "sshs_1",
		Transport:         SSHSessionTransportIroh,
		ConnectURL:        "wss://sandbox.example/v1/ssh-sessions",
		ConnectCredential: base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
		SandboxID:         "sbx_123",
		SSHUser:           "amika",
		HostPublicKey:     testEd25519PublicKey(t),
		Iroh: &SSHSessionIroh{
			EndpointID: strings.Repeat("0f", 32),
			RelayURL:   &relay,
			RigID:      "rig_abc-1",
			Port:       60899,
		},
	}
}

func TestSSHSessionValidateAcceptsAnIrohDescriptor(t *testing.T) {
	valid := validIrohSession(t)
	if err := valid.Validate("sbx_123"); err != nil {
		t.Fatalf("Validate iroh session: %v", err)
	}
	noRelay := validIrohSession(t)
	noRelay.Iroh.RelayURL = nil
	if err := noRelay.Validate("sbx_123"); err != nil {
		t.Fatalf("Validate iroh session with no relay: %v", err)
	}

	bad := func(edit func(*SSHSession)) SSHSession {
		s := validIrohSession(t)
		edit(&s)
		return s
	}
	text := func(v string) *string { return &v }
	tests := map[string]SSHSession{
		"no iroh object":         bad(func(s *SSHSession) { s.Iroh = nil }),
		"direct_ws with iroh":    bad(func(s *SSHSession) { s.Transport = SSHSessionTransportDirectWS }),
		"uppercase endpoint id":  bad(func(s *SSHSession) { s.Iroh.EndpointID = strings.Repeat("0F", 32) }),
		"short endpoint id":      bad(func(s *SSHSession) { s.Iroh.EndpointID = "0f" }),
		"rig id with a colon":    bad(func(s *SSHSession) { s.Iroh.RigID = "rig:1" }),
		"rig id with a space":    bad(func(s *SSHSession) { s.Iroh.RigID = "a b" }),
		"empty rig id":           bad(func(s *SSHSession) { s.Iroh.RigID = "" }),
		"port zero":              bad(func(s *SSHSession) { s.Iroh.Port = 0 }),
		"port too large":         bad(func(s *SSHSession) { s.Iroh.Port = 65536 }),
		"relay url like a flag":  bad(func(s *SSHSession) { s.Iroh.RelayURL = text("--direct") }),
		"relay url with a user":  bad(func(s *SSHSession) { s.Iroh.RelayURL = text("https://u:p@relay.example") }),
		"relay url other scheme": bad(func(s *SSHSession) { s.Iroh.RelayURL = text("file:///etc/passwd") }),
		"iroh with a bad route":  bad(func(s *SSHSession) { s.ConnectURL = "wss://sandbox.example/other" }),
	}
	for name, session := range tests {
		t.Run(name, func(t *testing.T) {
			if err := session.Validate("sbx_123"); err == nil {
				t.Fatal("Validate returned nil")
			}
		})
	}
}

func TestCreateSSHSessionSendsTheTransportList(t *testing.T) {
	var bodies []string
	irohSession := validIrohSession(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(data))
		answer := irohSession
		if !strings.Contains(string(data), `"iroh"`) {
			answer.Transport, answer.Iroh = SSHSessionTransportDirectWS, nil
		}
		_ = json.NewEncoder(w).Encode(answer)
	}))
	defer server.Close()
	client := NewClient(server.URL, "api-token")

	session, err := client.CreateSSHSession("sbx_123", []SSHSessionTransport{SSHSessionTransportDirectWS, SSHSessionTransportIroh})
	if err != nil || session.Transport != SSHSessionTransportIroh || session.Iroh.RigID != "rig_abc-1" {
		t.Fatalf("CreateSSHSession = %+v, %v", session, err)
	}
	if _, err := client.CreateSSHSession("sbx_123", []SSHSessionTransport{SSHSessionTransportDirectWS}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateSSHSession("sbx_123", nil); err != nil {
		t.Fatal(err)
	}
	want := []string{`{"transports":["direct_ws","iroh"]}`, `{"transports":["direct_ws"]}`, ``}
	for i := range want {
		if strings.TrimSpace(bodies[i]) != want[i] {
			t.Fatalf("body %d = %q, want %q", i, bodies[i], want[i])
		}
	}
}

func TestCreateSSHSessionRefusesATransportItDidNotList(t *testing.T) {
	irohSession := validIrohSession(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(irohSession)
	}))
	defer server.Close()
	client := NewClient(server.URL, "api-token")
	for _, transports := range [][]SSHSessionTransport{nil, {SSHSessionTransportDirectWS}} {
		if _, err := client.CreateSSHSession("sbx_123", transports); !errors.Is(err, ErrInvalidSSHSession) {
			t.Fatalf("transports %v: err = %v, want ErrInvalidSSHSession", transports, err)
		}
	}
}

func TestCreateSSHSessionReportsAnUnavailableTransport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"code":"ssh_transport_unavailable","message":"iroh is not available for this rig: its host is not in tunnel_iroh mode"}`))
	}))
	defer server.Close()
	_, err := NewClient(server.URL, "api-token").CreateSSHSession("sbx_123", []SSHSessionTransport{SSHSessionTransportIroh})
	if !errors.Is(err, ErrSSHTransportUnavailable) || !strings.Contains(err.Error(), "its host is not in tunnel_iroh mode") {
		t.Fatalf("err = %v", err)
	}
}
