// Package sshresume is the resumable byte stream that amikad's
// /v2/ssh-sessions route and the CLI's ssh-stdio-proxy run inside the bridge
// WebSocket. Each side counts the bytes it sends, acknowledges the bytes it
// receives, and keeps the bytes its peer has not acknowledged, so an SSH
// session outlives the WebSocket it started on.
//
// The design is amika-mono's
// specs/035-host-connection-drops.d/end-to-end-ssh-resume.md. This package
// holds what both ends share: the frame codec, the constants, the transport
// adapter, and Stream, which carries one session's bytes across transports.
// The handshake (HELLO and WELCOME), takeover and the grace period belong to
// each end: amikad's in go/internal/amikad/norelay, the CLI's in
// go/internal/ssh.
package sshresume

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"log/slog"
	"time"

	"github.com/coder/websocket"
)

// Sizes from the design's Buffers table.
const (
	// ReplayLimit bounds the bytes a side keeps that its peer has not
	// acknowledged, per direction per session. It is also the send window.
	ReplayLimit = 2 << 20
	// MaxDataBytes bounds the payload of one DATA frame.
	MaxDataBytes = 32 << 10
	// AckBytes is the received byte count that forces an ACK.
	AckBytes = 64 << 10
	// MaxFrameBytes bounds one frame, and so one WebSocket message.
	MaxFrameBytes = 64 << 10
	// SecretBytes is the size of a session secret.
	SecretBytes = 32
)

// Durations from the design's Grace and Liveness tables.
const (
	AckDelay     = 100 * time.Millisecond
	ResumeGrace  = 60 * time.Second
	HelloTimeout = 10 * time.Second
	DialTimeout  = 10 * time.Second
	PingInterval = 10 * time.Second
	DeadAfter    = 25 * time.Second
)

// CloseTakeover is the WebSocket close code amikad sends on a transport that a
// newer resume of the same session replaced.
const CloseTakeover websocket.StatusCode = 4100

// Timing holds the durations a session uses. Tests shorten them; a zero field
// takes the design's value.
type Timing struct {
	AckDelay     time.Duration
	PingInterval time.Duration
	DeadAfter    time.Duration
	// ResumeGrace is how long amikad keeps a session with no transport, and
	// how long the client tries to resume. It also bounds how long a side
	// waits, with a full buffer, for its peer to acknowledge anything.
	ResumeGrace  time.Duration
	HelloTimeout time.Duration
	DialTimeout  time.Duration
}

// WithDefaults returns t with each zero field set to the design's value.
func (t Timing) WithDefaults() Timing {
	defaults := []struct {
		field *time.Duration
		value time.Duration
	}{
		{&t.AckDelay, AckDelay},
		{&t.PingInterval, PingInterval},
		{&t.DeadAfter, DeadAfter},
		{&t.ResumeGrace, ResumeGrace},
		{&t.HelloTimeout, HelloTimeout},
		{&t.DialTimeout, DialTimeout},
	}
	for _, d := range defaults {
		if *d.field <= 0 {
			*d.field = d.value
		}
	}
	return t
}

// Secret is a session's only name and its resume credential. amikad makes it,
// keeps only its hash, and the client keeps it in process memory only. Every
// formatting path prints a placeholder, so a stray log line cannot carry it.
type Secret [SecretBytes]byte

// NewSecret returns 32 bytes from crypto/rand.
func NewSecret() (Secret, error) {
	var secret Secret
	_, err := rand.Read(secret[:])
	return secret, err
}

// Hash returns the SHA-256 hash amikad stores in place of the secret.
func (s Secret) Hash() SecretHash { return sha256.Sum256(s[:]) }

// String hides the secret from fmt.
func (Secret) String() string { return "[redacted]" }

// GoString hides the secret from fmt's %#v.
func (Secret) GoString() string { return "[redacted]" }

// LogValue hides the secret from log/slog.
func (Secret) LogValue() slog.Value { return slog.StringValue("[redacted]") }

// SecretHash is the SHA-256 hash of a Secret.
type SecretHash [sha256.Size]byte

// Equal compares two hashes in constant time.
func (h SecretHash) Equal(other SecretHash) bool {
	return subtle.ConstantTimeCompare(h[:], other[:]) == 1
}

// Ref names a session in logs: the first 8 bytes of the hash, in hex. It is
// not a credential.
func (h SecretHash) Ref() string { return hex.EncodeToString(h[:8]) }
