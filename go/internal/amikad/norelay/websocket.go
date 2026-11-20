package norelay

import (
	"net/http"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/sshresume"
	"github.com/gofixpoint/amika/go/internal/wsstream"
)

const maxWebSocketMessageBytes = 64 * 1024

// WebSocketUpgrader accepts binary, uncompressed WebSocket streams with a
// bounded per-message read limit. It serves both routes: a byte stream for
// SSHSessionsPath, and a frame transport for ResumableSSHSessionsPath.
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

// UpgradeTransport performs the RFC 6455 handshake and returns a frame
// transport, one sshresume frame per binary message.
func (WebSocketUpgrader) UpgradeTransport(w http.ResponseWriter, request *http.Request) (sshresume.Transport, error) {
	connection, err := websocket.Accept(w, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	return sshresume.NewWebSocketTransport(connection), nil
}
