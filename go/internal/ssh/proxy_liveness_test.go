package ssh

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var testLiveness = proxyLiveness{interval: 20 * time.Millisecond, timeout: 100 * time.Millisecond}

func TestCarryStreamsExitsWhenTheTransportStopsAnswering(t *testing.T) {
	// A peer that never reads also never answers a ping: the same as a path
	// that went dead without a close.
	stream := dialTestTransport(t, func(ctx context.Context, _ *websocket.Conn) { <-ctx.Done() })
	stdin, openSSH := io.Pipe()
	defer openSSH.Close()

	err := carryWithin(t, 5*time.Second, stream, stdin, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "did not answer a ping") {
		t.Fatalf("carryStreams error = %v, want a ping timeout", err)
	}
}

func TestCarryStreamsKeepsAnAnsweringTransportOpen(t *testing.T) {
	release := make(chan struct{})
	stream := dialTestTransport(t, func(ctx context.Context, connection *websocket.Conn) {
		// A reading peer answers pings.
		readCtx := connection.CloseRead(ctx)
		select {
		case <-release:
			_ = connection.Close(websocket.StatusNormalClosure, "")
		case <-readCtx.Done():
		}
	})
	stdin, openSSH := io.Pipe()
	defer openSSH.Close()

	done := make(chan error, 1)
	go func() { done <- carryStreams(context.Background(), stream, stdin, io.Discard, testLiveness) }()
	select {
	case err := <-done:
		t.Fatalf("carryStreams ended while pings were answered: %v", err)
	case <-time.After(10 * testLiveness.timeout):
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("carryStreams error after a normal close = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("carryStreams did not end after the transport closed")
	}
}

func TestCarryStreamsDoesNotBlameTheTransportForABlockedOpenSSH(t *testing.T) {
	stream := newSilentStream("from-sshd")
	stdout := &blockedWriter{release: make(chan struct{})}
	stdin, openSSH := io.Pipe()
	defer openSSH.Close()

	done := make(chan error, 1)
	go func() { done <- carryStreams(context.Background(), stream, stdin, stdout, testLiveness) }()
	select {
	case err := <-done:
		t.Fatalf("carryStreams ended while OpenSSH held a write: %v", err)
	case <-time.After(10 * testLiveness.timeout):
	}
	// Once OpenSSH takes the output, the proxy reads again, and a missing
	// pong counts.
	close(stdout.release)
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "did not answer a ping") {
			t.Fatalf("carryStreams error = %v, want a ping timeout", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("carryStreams did not notice the silent transport")
	}
}

func carryWithin(t *testing.T, limit time.Duration, stream Stream, stdin io.Reader, stdout io.Writer) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- carryStreams(context.Background(), stream, stdin, stdout, testLiveness) }()
	select {
	case err := <-done:
		return err
	case <-time.After(limit):
		t.Fatalf("carryStreams still runs after %s", limit)
		return nil
	}
}

// dialTestTransport opens a real WebSocket stream to a peer that serve runs.
func dialTestTransport(t *testing.T, serve func(context.Context, *websocket.Conn)) Stream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		serve(ctx, connection)
	}))
	t.Cleanup(func() {
		cancel()
		server.Close()
	})
	stream, err := (WebSocketDialer{}).Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), testConnectToken())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = stream.Close() })
	return stream
}

// silentStream returns its bytes once, then blocks until Close. Its pings
// never get an answer.
type silentStream struct {
	pending   []byte
	closed    chan struct{}
	closeOnce sync.Once
}

func newSilentStream(input string) *silentStream {
	return &silentStream{pending: []byte(input), closed: make(chan struct{})}
}

func (s *silentStream) Read(p []byte) (int, error) {
	if len(s.pending) > 0 {
		read := copy(p, s.pending)
		s.pending = s.pending[read:]
		return read, nil
	}
	<-s.closed
	return 0, io.EOF
}

func (s *silentStream) Write(p []byte) (int, error) { return len(p), nil }

func (s *silentStream) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	return nil
}

func (s *silentStream) CloseNow() error { return s.Close() }

func (s *silentStream) Ping(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

// blockedWriter is an OpenSSH that does not take output until release.
type blockedWriter struct{ release chan struct{} }

func (w *blockedWriter) Write(p []byte) (int, error) {
	<-w.release
	return len(p), nil
}
