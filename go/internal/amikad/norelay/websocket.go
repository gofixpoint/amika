package norelay

import (
	"net/http"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/wsstream"
)

const maxWebSocketMessageBytes = 64 * 1024

// WebSocketUpgrader accepts binary, uncompressed WebSocket streams with a
// bounded per-message read limit.
type WebSocketUpgrader struct{}

// Upgrade performs the RFC 6455 handshake and returns a byte-stream adapter.
func (WebSocketUpgrader) Upgrade(w http.ResponseWriter, request *http.Request) (Stream, error) {
	connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	return wsstream.New(request.Context(), connection, maxWebSocketMessageBytes), nil
}
