package sshresume

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Transport carries frames for one bridge WebSocket. A Stream reads from one
// goroutine and writes from up to two at once.
type Transport interface {
	// ReadFrame returns the next message. It returns an error once the
	// transport has ended, or for a message that is not binary.
	ReadFrame() ([]byte, error)
	// WriteFrame sends one message. The transport does not keep frame.
	WriteFrame(frame []byte) error
	// Close ends the transport with code, after the frames already written.
	// It is safe to call more than once, and returns within a short bound:
	// pending and later ReadFrame and WriteFrame calls then fail.
	Close(code websocket.StatusCode)
}

// closeHandshakeWait bounds how long Close waits for the peer to answer the
// close frame before it drops the connection. A transport being closed is
// often a dead one, and a takeover waits for it.
const closeHandshakeWait = 250 * time.Millisecond

// NewWebSocketTransport adapts a WebSocket connection to a Transport. It
// limits each message to MaxFrameBytes.
func NewWebSocketTransport(connection *websocket.Conn) Transport {
	connection.SetReadLimit(MaxFrameBytes)
	ctx, cancel := context.WithCancel(context.Background())
	return &webSocketTransport{connection: connection, ctx: ctx, cancel: cancel}
}

type webSocketTransport struct {
	connection *websocket.Conn
	// ctx bounds every read and write. coder/websocket closes the connection
	// when a pending call's context ends, which is how Close stops a reader
	// that waits on a silent peer.
	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

func (t *webSocketTransport) ReadFrame() ([]byte, error) {
	messageType, message, err := t.connection.Read(t.ctx)
	if err != nil {
		return nil, err
	}
	if messageType != websocket.MessageBinary {
		t.Close(websocket.StatusUnsupportedData)
		return nil, fmt.Errorf("%w: text message", ErrProtocol)
	}
	return message, nil
}

func (t *webSocketTransport) WriteFrame(frame []byte) error {
	return t.connection.Write(t.ctx, websocket.MessageBinary, frame)
}

func (t *webSocketTransport) Close(code websocket.StatusCode) {
	t.closeOnce.Do(func() {
		closed := make(chan struct{})
		go func() {
			defer close(closed)
			_ = t.connection.Close(code, "")
		}()
		timer := time.NewTimer(closeHandshakeWait)
		defer timer.Stop()
		select {
		case <-closed:
		case <-timer.C:
		}
		t.cancel()
	})
}
