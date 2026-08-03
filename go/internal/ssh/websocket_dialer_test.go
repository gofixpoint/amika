package ssh

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestWebSocketDialerSendsCredentialOnlyInHeader(t *testing.T) {
	credential := testConnectToken()
	seen := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		seen <- request.Clone(context.Background())
		connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		messageType, data, err := connection.Read(context.Background())
		if err == nil {
			_ = connection.Write(context.Background(), messageType, data)
		}
	}))
	defer server.Close()

	connectURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/ssh-sessions"
	stream, err := (WebSocketDialer{}).Dial(context.Background(), connectURL, credential)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer stream.Close()
	if _, err := stream.Write([]byte("ssh")); err != nil {
		t.Fatalf("stream write: %v", err)
	}
	got, err := io.ReadAll(io.LimitReader(stream, 3))
	if err != nil {
		t.Fatalf("stream read: %v", err)
	}
	if string(got) != "ssh" {
		t.Fatalf("echo = %q", got)
	}
	request := <-seen
	if request.Header.Get("Authorization") != "Bearer "+credential {
		t.Fatalf("Authorization = %q", request.Header.Get("Authorization"))
	}
	if strings.Contains(request.URL.String(), credential) {
		t.Fatalf("credential leaked into URL %q", request.URL)
	}
	if extension := request.Header.Get("Sec-WebSocket-Extensions"); extension != "" {
		t.Fatalf("compression requested: %q", extension)
	}
}
