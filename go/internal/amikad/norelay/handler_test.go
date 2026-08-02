package norelay

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeVerifier struct {
	want  string
	calls int
}

func (v *fakeVerifier) Verify(token string) bool {
	v.calls++
	return token == v.want
}

type fakeStream struct {
	read   *bytes.Reader
	writes bytes.Buffer
}

func newFakeStream(input string) *fakeStream {
	return &fakeStream{read: bytes.NewReader([]byte(input))}
}

func (s *fakeStream) Read(p []byte) (int, error)  { return s.read.Read(p) }
func (s *fakeStream) Write(p []byte) (int, error) { return s.writes.Write(p) }
func (s *fakeStream) Close() error                { return nil }

type fakeUpgrader struct {
	stream Stream
	calls  int
}

func (u *fakeUpgrader) Upgrade(http.ResponseWriter, *http.Request) (Stream, error) {
	u.calls++
	return u.stream, nil
}

type fakeDialer struct {
	stream  Stream
	calls   int
	network string
	address string
}

func (d *fakeDialer) DialContext(_ context.Context, network, address string) (Stream, error) {
	d.calls++
	d.network = network
	d.address = address
	return d.stream, nil
}

type discardLogger struct{}

func (discardLogger) Record(Event) {}

func TestHandlerRejectsMissingTokenBeforeUpgradeOrDial(t *testing.T) {
	verifier := &fakeVerifier{want: "secret-token"}
	upgrader := &fakeUpgrader{stream: newFakeStream("")}
	dialer := &fakeDialer{stream: newFakeStream("")}
	handler := NewHandler(Config{MaxConnections: 64, SSHDAddress: "127.0.0.1:22"}, Dependencies{
		Verifier: verifier,
		Upgrader: upgrader,
		Dialer:   dialer,
		Logger:   discardLogger{},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if upgrader.calls != 0 || dialer.calls != 0 {
		t.Fatalf("unauthorized request reached upgrader=%d dialer=%d", upgrader.calls, dialer.calls)
	}
}

func TestHandlerBridgesAuthenticatedBytesToLoopbackSSHD(t *testing.T) {
	websocket := newFakeStream("ssh-from-client")
	loopback := newFakeStream("ssh-from-server")
	verifier := &fakeVerifier{want: "secret-token"}
	upgrader := &fakeUpgrader{stream: websocket}
	dialer := &fakeDialer{stream: loopback}
	handler := NewHandler(Config{MaxConnections: 64, SSHDAddress: "127.0.0.1:22"}, Dependencies{
		Verifier: verifier,
		Upgrader: upgrader,
		Dialer:   dialer,
		Logger:   discardLogger{},
	})

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
	request.Header.Set("Authorization", "Bearer secret-token")
	handler.ServeHTTP(response, request)

	if verifier.calls != 1 {
		t.Fatalf("verifier calls = %d, want 1", verifier.calls)
	}
	if upgrader.calls != 1 || dialer.calls != 1 {
		t.Fatalf("authenticated request reached upgrader=%d dialer=%d, want 1 each", upgrader.calls, dialer.calls)
	}
	if dialer.network != "tcp" || dialer.address != "127.0.0.1:22" {
		t.Fatalf("dial = %s %s, want tcp 127.0.0.1:22", dialer.network, dialer.address)
	}
	if got := loopback.writes.String(); got != "ssh-from-client" {
		t.Fatalf("loopback received %q, want client bytes", got)
	}
	if got := websocket.writes.String(); got != "ssh-from-server" {
		t.Fatalf("websocket received %q, want server bytes", got)
	}
}
