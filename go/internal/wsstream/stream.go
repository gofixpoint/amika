// Package wsstream adapts bounded binary WebSocket messages to an opaque byte
// stream for SSH tunneling.
package wsstream

import (
	"context"
	"errors"
	"io"
	"sync"

	"github.com/coder/websocket"
)

// Stream is a concurrent-reader/writer binary WebSocket byte stream.
type Stream struct {
	connection *websocket.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	maxMessage int
	readMu     sync.Mutex
	reader     io.Reader
	closeOnce  sync.Once
}

// New creates a stream with a bounded per-message read and write size.
func New(parent context.Context, connection *websocket.Conn, maxMessage int) *Stream {
	ctx, cancel := context.WithCancel(parent)
	connection.SetReadLimit(int64(maxMessage))
	return &Stream{
		connection: connection,
		ctx:        ctx,
		cancel:     cancel,
		maxMessage: maxMessage,
	}
}

// Read joins consecutive binary messages into one byte stream.
func (s *Stream) Read(buffer []byte) (int, error) {
	s.readMu.Lock()
	defer s.readMu.Unlock()
	for {
		if s.reader == nil {
			messageType, reader, err := s.connection.Reader(s.ctx)
			if err != nil {
				return 0, err
			}
			if messageType != websocket.MessageBinary {
				_ = s.connection.Close(websocket.StatusUnsupportedData, "binary messages required")
				return 0, errors.New("non-binary WebSocket message")
			}
			s.reader = reader
		}
		read, err := s.reader.Read(buffer)
		if errors.Is(err, io.EOF) {
			s.reader = nil
			if read != 0 {
				return read, nil
			}
			continue
		}
		return read, err
	}
}

// Write sends one bounded binary message.
func (s *Stream) Write(buffer []byte) (int, error) {
	if len(buffer) > s.maxMessage {
		return 0, websocket.ErrMessageTooBig
	}
	if err := s.connection.Write(s.ctx, websocket.MessageBinary, buffer); err != nil {
		return 0, err
	}
	return len(buffer), nil
}

// Close cancels active I/O and closes the underlying socket immediately.
func (s *Stream) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		s.cancel()
		closeErr = s.connection.CloseNow()
	})
	return closeErr
}
