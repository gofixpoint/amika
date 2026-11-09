// Package norelay serves authenticated WebSocket streams to loopback sshd.
package norelay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofixpoint/amika/go/internal/sshresume"
)

// SSHSessionsPath is the no-relay WebSocket upgrade route. It carries raw SSH
// bytes, and its session ends with its WebSocket.
const SSHSessionsPath = "/v1/ssh-sessions"

const copyBufferBytes = 32 * 1024

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
// The context carries the request cancellation and deadline, network must be
// "tcp", and address is the configured loopback sshd endpoint. A successful
// call returns the connected bidirectional stream; a failure returns an error
// and no usable stream.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (Stream, error)
}

// Config contains bounded bridge settings.
type Config struct {
	// MaxConnections bounds the sshd connections of both routes together. A
	// resumable session keeps its slot while it waits for a resume.
	MaxConnections int
	SSHDAddress    string
	// ResumeTiming shortens the resumable route's timers in tests. Zero
	// fields take the design's values.
	ResumeTiming sshresume.Timing
}

// Dependencies are the handler's security-sensitive boundaries.
type Dependencies struct {
	Verifier TokenVerifier
	Upgrader Upgrader
	// FrameUpgrader serves ResumableSSHSessionsPath. Without it that route
	// answers 503.
	FrameUpgrader FrameUpgrader
	Dialer        Dialer
	Logger        *slog.Logger
	// Clock drives the resumable route's timers. Nil is the system clock.
	Clock sshresume.Clock
}

// Handler serves the no-relay routes: SSHSessionsPath and
// ResumableSSHSessionsPath.
type Handler struct {
	config    Config
	deps      Dependencies
	slots     chan struct{}
	active    atomic.Int64
	streamsMu sync.Mutex
	streams   map[Stream]struct{}
	// pendingHellos caps the resumable transports that wait for HELLO.
	pendingHellos chan struct{}
	resume        *resumeRegistry
}

// DefaultMaxConnections is the connection cap used when Config.MaxConnections
// is left unset.
const DefaultMaxConnections = 64

// NewHandler creates a no-relay handler without opening any listener.
func NewHandler(config Config, deps Dependencies) *Handler {
	if config.MaxConnections <= 0 {
		config.MaxConnections = DefaultMaxConnections
	}
	if config.SSHDAddress == "" {
		config.SSHDAddress = "127.0.0.1:22"
	}
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if deps.Clock == nil {
		deps.Clock = sshresume.SystemClock{}
	}
	config.ResumeTiming = config.ResumeTiming.WithDefaults()
	return &Handler{
		config:        config,
		deps:          deps,
		slots:         make(chan struct{}, config.MaxConnections),
		streams:       make(map[Stream]struct{}),
		pendingHellos: make(chan struct{}, maxPendingHellos),
		resume:        newResumeRegistry(),
	}
}

// ActiveConnections returns the number of bridge sessions currently holding a
// capacity slot, attached or waiting for a resume.
func (h *Handler) ActiveConnections() int64 { return h.active.Load() }

// Close cancels all active bridge I/O during daemon shutdown. Each resumable
// session gets ABORT on its transport, and its sshd connection closes.
func (h *Handler) Close() {
	h.streamsMu.Lock()
	streams := make([]Stream, 0, len(h.streams))
	for stream := range h.streams {
		streams = append(streams, stream)
	}
	h.streamsMu.Unlock()
	for _, stream := range streams {
		_ = stream.Close()
	}
	h.closeResumable()
}

// ServeHTTP authenticates the caller and serves the route its path names.
func (h *Handler) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	refusal := "ssh_bridge_refused"
	switch request.URL.Path {
	case SSHSessionsPath:
	case ResumableSSHSessionsPath:
		refusal = "ssh_resume_refused"
	default:
		http.NotFound(w, request)
		return
	}
	if request.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	upgraderMissing := h.deps.Upgrader == nil
	if request.URL.Path == ResumableSSHSessionsPath {
		upgraderMissing = h.deps.FrameUpgrader == nil
	}
	if h.deps.Verifier == nil || upgraderMissing || h.deps.Dialer == nil {
		h.log(refusal, slog.String("reason", "not_configured"))
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	token, ok := requestBearerToken(request)
	if !ok || !h.deps.Verifier.Verify(token) {
		h.log(refusal, slog.String("reason", "unauthorized"))
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if request.URL.Path == ResumableSSHSessionsPath {
		h.serveResumable(w, request)
		return
	}
	h.serveRaw(w, request)
}

// serveRaw bridges one opaque stream for SSHSessionsPath.
func (h *Handler) serveRaw(w http.ResponseWriter, request *http.Request) {
	select {
	case h.slots <- struct{}{}:
		h.active.Add(1)
		defer func() {
			<-h.slots
			h.active.Add(-1)
		}()
	default:
		h.log("ssh_bridge_refused", slog.String("reason", "capacity"))
		http.Error(w, "capacity exceeded", http.StatusTooManyRequests)
		return
	}

	websocketStream, err := h.deps.Upgrader.Upgrade(w, request)
	if err != nil {
		h.log("ssh_bridge_refused", slog.String("reason", "upgrade_failed"))
		return
	}
	h.track(websocketStream)
	defer h.untrack(websocketStream)
	defer websocketStream.Close()

	sshdStream, err := h.deps.Dialer.DialContext(
		request.Context(),
		"tcp",
		h.config.SSHDAddress,
	)
	if err != nil {
		h.log("ssh_bridge_refused", slog.String("reason", "sshd_unreachable"))
		return
	}
	h.track(sshdStream)
	defer h.untrack(sshdStream)
	defer sshdStream.Close()

	sessionID := newSessionID()
	startedAt := time.Now()
	h.log("ssh_bridge_open", slog.String("session_id", sessionID), slog.String("mode", "raw"))
	fromClient, fromSSHD, closeReason := bridge(websocketStream, sshdStream)
	h.log(
		"ssh_bridge_close",
		slog.String("session_id", sessionID),
		slog.String("reason", closeReason),
		slog.Int64("duration_ms", time.Since(startedAt).Milliseconds()),
		slog.Int64("bytes_from_client", fromClient),
		slog.Int64("bytes_from_sshd", fromSSHD),
	)
}

func requestBearerToken(request *http.Request) (string, bool) {
	values := request.Header.Values("Authorization")
	if len(values) != 1 {
		return "", false
	}
	scheme, token, found := strings.Cut(values[0], " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" || strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}

type copyResult struct {
	name  string
	bytes int64
	err   error
}

func bridge(websocketStream, sshdStream Stream) (fromClient, fromSSHD int64, closeReason string) {
	results := make(chan copyResult, 2)
	go copyStream(results, "client", sshdStream, websocketStream)
	go copyStream(results, "sshd", websocketStream, sshdStream)

	first := <-results
	_ = websocketStream.Close()
	_ = sshdStream.Close()
	second := <-results

	for _, result := range []copyResult{first, second} {
		switch result.name {
		case "client":
			fromClient = result.bytes
		case "sshd":
			fromSSHD = result.bytes
		}
	}
	if first.err != nil && !errors.Is(first.err, io.EOF) {
		return fromClient, fromSSHD, first.name + "_copy_error"
	}
	return fromClient, fromSSHD, first.name + "_closed"
}

func copyStream(results chan<- copyResult, name string, destination io.Writer, source io.Reader) {
	buffer := make([]byte, copyBufferBytes)
	written, err := io.CopyBuffer(destination, source, buffer)
	results <- copyResult{name: name, bytes: written, err: err}
}

func newSessionID() string {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "unavailable"
	}
	return "sshs_" + hex.EncodeToString(random[:])
}

func (h *Handler) log(message string, attributes ...any) {
	h.deps.Logger.Info(message, attributes...)
}

func (h *Handler) track(stream Stream) {
	h.streamsMu.Lock()
	h.streams[stream] = struct{}{}
	h.streamsMu.Unlock()
}

func (h *Handler) untrack(stream Stream) {
	h.streamsMu.Lock()
	delete(h.streams, stream)
	h.streamsMu.Unlock()
}
