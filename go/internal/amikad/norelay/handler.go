// Package norelay serves authenticated WebSocket streams to loopback sshd.
package norelay

import (
	"context"
	"errors"
	"io"
	"net/http"
)

// SSHSessionsPath is the no-relay WebSocket upgrade route.
const SSHSessionsPath = "/v1/ssh-sessions"

// ErrNotImplemented marks the fail-closed no-relay handler.
var ErrNotImplemented = errors.New("no-relay SSH bridge is not implemented")

// Stream is one bidirectional byte stream.
type Stream interface {
	io.Reader
	io.Writer
	io.Closer
}

// TokenVerifier authenticates a bearer token without exposing stored token
// material to the HTTP layer.
type TokenVerifier interface {
	Verify(string) bool
}

// Upgrader upgrades an authenticated HTTP request into a binary stream.
type Upgrader interface {
	Upgrade(http.ResponseWriter, *http.Request) (Stream, error)
}

// Dialer opens the loopback sshd stream after authentication and upgrade.
type Dialer interface {
	DialContext(context.Context, string, string) (Stream, error)
}

// Event is the complete metadata-only log shape. It cannot carry request
// headers, credentials, or SSH payload bytes.
type Event struct {
	SessionID       string
	Outcome         string
	CloseReason     string
	BytesFromClient int64
	BytesFromSSHD   int64
}

// Logger records typed metadata-only bridge events.
type Logger interface {
	Record(Event)
}

// Config contains bounded bridge settings.
type Config struct {
	MaxConnections int
	SSHDAddress    string
}

// Dependencies are the handler's security-sensitive boundaries.
type Dependencies struct {
	Verifier TokenVerifier
	Upgrader Upgrader
	Dialer   Dialer
	Logger   Logger
}

// Handler is a fail-closed placeholder for the no-relay route.
type Handler struct {
	config Config
	deps   Dependencies
}

// NewHandler creates a no-relay handler without opening any listener.
func NewHandler(config Config, deps Dependencies) *Handler {
	return &Handler{config: config, deps: deps}
}

// ServeHTTP rejects requests until authentication, capacity accounting, and
// bounded byte copying are implemented.
func (h *Handler) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	_ = h.config
	_ = h.deps
	w.Header().Set("Cache-Control", "no-store")
	http.Error(w, ErrNotImplemented.Error(), http.StatusServiceUnavailable)
}
