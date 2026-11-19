package norelay

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestHandlerRejectsMissingTokenBeforeUpgradeOrDial(t *testing.T) {
	verifier := &fakeVerifier{want: "secret-token"}
	upgrader := &fakeUpgrader{stream: newFakeStream("")}
	dialer := &fakeDialer{stream: newFakeStream("")}
	handler := NewHandler(Config{MaxConnections: 64, SSHDAddress: "127.0.0.1:22"}, Dependencies{
		Verifier: verifier,
		Upgrader: upgrader,
		Dialer:   dialer,
		Logger:   testLogger(),
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
		Logger:   testLogger(),
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

type blockingStream struct {
	closed chan struct{}
	once   sync.Once
}

func newBlockingStream() *blockingStream { return &blockingStream{closed: make(chan struct{})} }
func (s *blockingStream) Read([]byte) (int, error) {
	<-s.closed
	return 0, io.EOF
}
func (s *blockingStream) Write(buffer []byte) (int, error) { return len(buffer), nil }
func (s *blockingStream) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestHandlerEnforcesCapacityBeforeUpgrade(t *testing.T) {
	websocket := newBlockingStream()
	loopback := newBlockingStream()
	handler := NewHandler(Config{MaxConnections: 1}, Dependencies{
		Verifier: &fakeVerifier{want: "secret-token"},
		Upgrader: &fakeUpgrader{stream: websocket},
		Dialer:   &fakeDialer{stream: loopback},
		Logger:   testLogger(),
	})
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
		request.Header.Set("Authorization", "Bearer secret-token")
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	deadline := time.Now().Add(time.Second)
	for handler.ActiveConnections() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if handler.ActiveConnections() != 1 {
		t.Fatal("first connection did not acquire capacity")
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
	request.Header.Set("Authorization", "Bearer secret-token")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusTooManyRequests)
	}
	websocket.Close()
	loopback.Close()
	<-firstDone
}

func TestHandlerNeverLogsAuthorizationMaterial(t *testing.T) {
	secret := "secret-authorization-material"
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := NewHandler(Config{}, Dependencies{
		Verifier: &fakeVerifier{want: "different"},
		Upgrader: &fakeUpgrader{stream: newFakeStream("")},
		Dialer:   &fakeDialer{stream: newFakeStream("")},
		Logger:   logger,
	})
	request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
	request.Header.Set("Authorization", "Bearer "+secret)
	handler.ServeHTTP(httptest.NewRecorder(), request)
	if strings.Contains(logs.String(), secret) || strings.Contains(logs.String(), "Authorization") {
		t.Fatalf("logs exposed credentials: %s", logs.String())
	}
}

func TestHandlerRejectsMalformedAuthorizationBeforeUpgrade(t *testing.T) {
	for _, header := range []string{
		"secret-token",
		"Bearer",
		"Bearer secret-token trailing",
		"Basic secret-token",
	} {
		upgrader := &fakeUpgrader{stream: newFakeStream("")}
		dialer := &fakeDialer{stream: newFakeStream("")}
		handler := NewHandler(Config{}, Dependencies{
			Verifier: &fakeVerifier{want: "secret-token"},
			Upgrader: upgrader,
			Dialer:   dialer,
			Logger:   testLogger(),
		})
		request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
		request.Header.Set("Authorization", header)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || upgrader.calls != 0 || dialer.calls != 0 {
			t.Fatalf("header %q reached status=%d upgrade=%d dial=%d", header, response.Code, upgrader.calls, dialer.calls)
		}
	}
}

// switchVerifier accepts one token until it is revoked. It is safe for the
// concurrent recheck.
type switchVerifier struct {
	revoked atomic.Bool
}

func (v *switchVerifier) Verify(token string) bool {
	return token == "secret-token" && !v.revoked.Load()
}

// openSession starts one authenticated session that stays open until its
// streams close. It returns the channel that closes when ServeHTTP returns.
func openSession(t *testing.T, handler *Handler) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		request := httptest.NewRequest(http.MethodGet, SSHSessionsPath, nil)
		request.Header.Set("Authorization", "Bearer secret-token")
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	deadline := time.Now().Add(time.Second)
	for handler.ActiveConnections() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if handler.ActiveConnections() != 1 {
		t.Fatal("session did not open")
	}
	return done
}

func TestHandlerClosesSessionWhenTokenIsRevoked(t *testing.T) {
	var logs syncBuffer
	verifier := &switchVerifier{}
	handler := NewHandler(Config{RecheckInterval: 5 * time.Millisecond}, Dependencies{
		Verifier: verifier,
		Upgrader: &fakeUpgrader{stream: newBlockingStream()},
		Dialer:   &fakeDialer{stream: newBlockingStream()},
		Logger:   slog.New(slog.NewTextHandler(&logs, nil)),
	})
	done := openSession(t, handler)

	verifier.revoked.Store(true)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("session stayed open after its token was revoked")
	}
	if !strings.Contains(logs.String(), "reason=token_revoked") {
		t.Fatalf("close log = %q, want reason=token_revoked", logs.String())
	}
}

func TestHandlerKeepsSessionWhileTokenVerifies(t *testing.T) {
	websocket := newBlockingStream()
	handler := NewHandler(Config{RecheckInterval: 5 * time.Millisecond}, Dependencies{
		Verifier: &switchVerifier{},
		Upgrader: &fakeUpgrader{stream: websocket},
		Dialer:   &fakeDialer{stream: newBlockingStream()},
		Logger:   testLogger(),
	})
	done := openSession(t, handler)

	select {
	case <-done:
		t.Fatal("session closed while its token still verified")
	case <-time.After(50 * time.Millisecond):
	}
	websocket.Close()
	<-done
}

// syncBuffer is a bytes.Buffer that the session goroutine and the test can
// share.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
