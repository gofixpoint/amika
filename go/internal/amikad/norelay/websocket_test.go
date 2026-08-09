package norelay

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
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
