package sshresume

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// webSocketPair returns a server Transport and the raw client connection.
func webSocketPair(t *testing.T) (Transport, *websocket.Conn) {
	t.Helper()
	accepted := make(chan Transport, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(w, request, nil)
		if err != nil {
			return
		}
		accepted <- NewWebSocketTransport(connection)
		<-request.Context().Done()
	}))
	t.Cleanup(server.Close)
	client, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.CloseNow() })
	return <-accepted, client
}

func TestWebSocketTransportCarriesBinaryFrames(t *testing.T) {
	transport, client := webSocketPair(t)
	if err := client.Write(context.Background(), websocket.MessageBinary, []byte{byte(FramePing), 0, 0, 0, 0, 0, 0, 0, 1}); err != nil {
		t.Fatal(err)
	}
	frame, err := transport.ReadFrame()
	if err != nil || len(frame) != 9 {
		t.Fatalf("frame = %x, err = %v", frame, err)
	}
	if err := transport.WriteFrame([]byte{byte(FrameAck), 0, 0, 0, 0, 0, 0, 0, 2}); err != nil {
		t.Fatal(err)
	}
	if messageType, message, err := client.Read(context.Background()); err != nil || messageType != websocket.MessageBinary || len(message) != 9 {
		t.Fatalf("client read type %v len %d err %v", messageType, len(message), err)
	}
}

func TestWebSocketTransportRefusesTextMessages(t *testing.T) {
	transport, client := webSocketPair(t)
	if err := client.Write(context.Background(), websocket.MessageText, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.ReadFrame(); !errors.Is(err, ErrProtocol) {
		t.Fatalf("error = %v, want ErrProtocol", err)
	}
}

func TestWebSocketTransportRefusesOversizedMessages(t *testing.T) {
	transport, client := webSocketPair(t)
	go func() { _ = client.Write(context.Background(), websocket.MessageBinary, make([]byte, MaxFrameBytes+1)) }()
	if _, err := transport.ReadFrame(); err == nil {
		t.Fatal("an oversized message was read")
	}
}

// A peer that has stopped reading must not hold Close: a takeover waits for
// it.
func TestWebSocketTransportCloseIsBoundedWithASilentPeer(t *testing.T) {
	transport, _ := webSocketPair(t)
	readErr := make(chan error, 1)
	go func() {
		_, err := transport.ReadFrame()
		readErr <- err
	}()
	started := time.Now()
	transport.Close(CloseTakeover)
	if elapsed := time.Since(started); elapsed > 2*closeHandshakeWait+time.Second {
		t.Fatalf("Close took %s", elapsed)
	}
	select {
	case err := <-readErr:
		if err == nil {
			t.Fatal("pending read returned no error after Close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending read still blocked after Close")
	}
	if err := transport.WriteFrame([]byte{1}); err == nil {
		t.Fatal("write after Close succeeded")
	}
}

func TestWebSocketTransportCloseSendsItsCode(t *testing.T) {
	transport, client := webSocketPair(t)
	go transport.Close(CloseTakeover)
	_, _, err := client.Read(context.Background())
	if status := websocket.CloseStatus(err); status != CloseTakeover {
		t.Fatalf("client saw close status %d, want %d", status, CloseTakeover)
	}
}
