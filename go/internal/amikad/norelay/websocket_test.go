package norelay

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	"github.com/gofixpoint/amika/go/internal/sshresume/resumetest"
)

func TestWebSocketUpgraderCarriesBinaryBytesWithoutCompression(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		stream, err := (WebSocketUpgrader{}).Upgrade(w, request)
		if err != nil {
			return
		}
		defer stream.Close()
		buffer := make([]byte, 32)
		read, err := stream.Read(buffer)
		if err != nil {
			return
		}
		_, _ = stream.Write(buffer[:read])
	}))
	defer server.Close()

	connectURL := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, response, err := websocket.Dial(context.Background(), connectURL, &websocket.DialOptions{
		CompressionMode: websocket.CompressionNoContextTakeover,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer connection.CloseNow()
	if extension := response.Header.Get("Sec-WebSocket-Extensions"); extension != "" {
		t.Fatalf("compression extension negotiated: %q", extension)
	}

	want := []byte("opaque-ssh-bytes")
	if err := connection.Write(context.Background(), websocket.MessageBinary, want); err != nil {
		t.Fatalf("write: %v", err)
	}
	messageType, got, err := connection.Read(context.Background())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if messageType != websocket.MessageBinary || string(got) != string(want) {
		t.Fatalf("message = type %v body %q, want binary %q", messageType, got, want)
	}
}

func TestWebSocketUpgraderRejectsOversizedMessages(t *testing.T) {
	result := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		stream, err := (WebSocketUpgrader{}).Upgrade(w, request)
		if err != nil {
			result <- err
			return
		}
		defer stream.Close()
		_, err = io.Copy(io.Discard, stream)
		result <- err
	}))
	defer server.Close()

	connectURL := "ws" + strings.TrimPrefix(server.URL, "http")
	connection, _, err := websocket.Dial(context.Background(), connectURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	payload := make([]byte, maxWebSocketMessageBytes+1)
	if err := connection.Write(context.Background(), websocket.MessageBinary, payload); err != nil {
		t.Fatalf("write oversized message: %v", err)
	}
	connection.CloseNow()
	if err := <-result; !strings.Contains(err.Error(), "message too big") {
		t.Fatalf("server read error = %v, want message too big", err)
	}
}

// The resumable route over a real WebSocket: HELLO in, WELCOME with a fresh
// secret out, then bytes both ways through sshd.
func TestWebSocketUpgraderServesTheResumableRoute(t *testing.T) {
	dialer := &pipeDialer{sshd: make(chan net.Conn, 1)}
	handler := NewHandler(Config{}, Dependencies{
		Verifier:      tokenVerifier{},
		Upgrader:      WebSocketUpgrader{},
		FrameUpgrader: WebSocketUpgrader{},
		Dialer:        dialer,
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	defer handler.Close()

	header := http.Header{}
	header.Set("Authorization", "Bearer "+testToken)
	connection, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http")+ResumableSSHSessionsPath, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer connection.CloseNow()
	client := sshresume.NewWebSocketTransport(connection)
	hello, _ := sshresume.MarshalFrame(sshresume.Frame{Type: sshresume.FrameHello, Mode: sshresume.HelloNew})
	if err := client.WriteFrame(hello); err != nil {
		t.Fatal(err)
	}
	message, err := client.ReadFrame()
	if err != nil {
		t.Fatal(err)
	}
	welcome, err := sshresume.ParseFrame(message)
	if err != nil || welcome.Type != sshresume.FrameWelcome || welcome.Status != sshresume.WelcomeNew || welcome.Secret == (sshresume.Secret{}) {
		t.Fatalf("welcome = %+v, err = %v", welcome, err)
	}
	sshd := <-dialer.sshd
	defer sshd.Close()
	data, _ := sshresume.MarshalFrame(sshresume.Frame{Type: sshresume.FrameData, Payload: []byte("ping")})
	if err := client.WriteFrame(data); err != nil {
		t.Fatal(err)
	}
	if got := readExactly(t, sshd, 4); string(got) != "ping" {
		t.Fatalf("sshd read %q", got)
	}
}

// An old CLI keeps using /v1 on the same handler.
func TestHandlerServesBothRoutes(t *testing.T) {
	handler := NewHandler(Config{}, Dependencies{
		Verifier:      tokenVerifier{},
		Upgrader:      &fakeUpgrader{stream: newFakeStream("from-client")},
		FrameUpgrader: &pipeUpgrader{ends: make(chan *resumetest.End)},
		Dialer:        &fakeDialer{stream: newFakeStream("")},
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, authorizedRequest(SSHSessionsPath))
	if response.Code != http.StatusOK {
		t.Fatalf("v1 status = %d", response.Code)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, authorizedRequest("/v3/ssh-sessions"))
	if response.Code != http.StatusNotFound {
		t.Fatalf("unknown route status = %d", response.Code)
	}
}
