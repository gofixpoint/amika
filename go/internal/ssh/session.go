package ssh

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/wsstream"
	cryptossh "golang.org/x/crypto/ssh"
)

const proxyCopyBufferBytes = 32 * 1024

var safeAliasPart = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$`)

// ErrInvalidSessionAlias marks a host value that is not a safe v2 Amika
// alias.
var ErrInvalidSessionAlias = errors.New("invalid Amika SSH host alias")

// ErrHostKeyMismatch marks a descriptor whose immutable identity does not
// match the requested host.
var ErrHostKeyMismatch = errors.New("SSH host identity mismatch")

// SandboxAlias identifies the immutable sandbox id parsed from a v2 host alias.
type SandboxAlias struct {
	Name string
	ID   string
}

// SessionConfig describes the strict wildcard SSH configuration.
type SessionConfig struct {
	IdentityFile   string
	KnownHostsFile string
	ProxyCommand   string
}

// SessionCreator creates a fresh transport descriptor for each SSH dial.
type SessionCreator interface {
	CreateSSHSession(string) (*apiclient.SSHSession, error)
}

// Stream is the binary WebSocket abstraction used by the stdio proxy.
type Stream interface {
	io.Reader
	io.Writer
	io.Closer
}

// SessionDialer opens a binary stream with a credential sent outside argv.
type SessionDialer interface {
	Dial(context.Context, string, string) (Stream, error)
}

// HostKeyPinStore atomically creates or verifies an alias-keyed known-host pin.
// An existing different key must fail closed.
type HostKeyPinStore interface {
	Pin(string, string) error
}

// BuildSessionAlias combines a safe human name and immutable sandbox id.
func BuildSessionAlias(name, id string) (string, error) {
	if name == "" || id == "" || !safeAliasPart.MatchString(name) || !safeAliasPart.MatchString(id) || strings.Contains(id, ".") {
		return "", ErrInvalidSessionAlias
	}
	alias := name + "." + id + ".amika"
	if len(alias) > 253 {
		return "", ErrInvalidSessionAlias
	}
	return alias, nil
}

// ParseSessionAlias splits from the right so dotted sandbox names remain
// intact.
func ParseSessionAlias(alias string) (SandboxAlias, error) {
	if len(alias) > 253 || !strings.HasSuffix(alias, ".amika") || strings.ContainsAny(alias, "\r\n\t *?![]\\") {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	withoutSuffix := strings.TrimSuffix(alias, ".amika")
	separator := strings.LastIndexByte(withoutSuffix, '.')
	if separator <= 0 || separator == len(withoutSuffix)-1 {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	parsed := SandboxAlias{Name: withoutSuffix[:separator], ID: withoutSuffix[separator+1:]}
	if !safeAliasPart.MatchString(parsed.Name) || !safeAliasPart.MatchString(parsed.ID) || strings.Contains(parsed.ID, ".") {
		return SandboxAlias{}, ErrInvalidSessionAlias
	}
	return parsed, nil
}

// RenderSessionConfig renders the strict wildcard block used only by v2
// aliases.
func RenderSessionConfig(config SessionConfig) (string, error) {
	if !safeConfigPath(config.IdentityFile) || !safeConfigPath(config.KnownHostsFile) || config.ProxyCommand != "amika plumbing ssh-stdio-proxy %h" {
		return "", ErrInvalidSessionAlias
	}
	return fmt.Sprintf(`Host *.amika
  User amika
  IdentityFile %s
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile %s
  ProxyCommand %s
  ServerAliveInterval 15
  ServerAliveCountMax 3
`, config.IdentityFile, config.KnownHostsFile, config.ProxyCommand), nil
}

// KnownHostLine returns one canonical alias-keyed Ed25519 pin.
func KnownHostLine(alias, hostPublicKey string) (string, error) {
	if _, err := ParseSessionAlias(alias); err != nil {
		return "", err
	}
	canonical, err := canonicalHostPublicKey(hostPublicKey)
	if err != nil {
		return "", err
	}
	return alias + " " + canonical + "\n", nil
}

// PrepareSessionHost fetches a descriptor and pins its key before OpenSSH is
// launched.
func PrepareSessionHost(
	creator SessionCreator,
	pins HostKeyPinStore,
	sandboxID string,
	alias string,
) (*apiclient.SSHSession, error) {
	parsed, err := ParseSessionAlias(alias)
	if err != nil || parsed.ID != sandboxID {
		return nil, ErrHostKeyMismatch
	}
	session, err := creator.CreateSSHSession(sandboxID)
	if err != nil {
		return nil, err
	}
	if err := session.Validate(sandboxID); err != nil {
		return nil, err
	}
	canonical, err := canonicalHostPublicKey(session.HostPublicKey)
	if err != nil {
		return nil, err
	}
	if err := pins.Pin(alias, canonical); err != nil {
		return nil, err
	}
	return session, nil
}

// ProxySession creates a fresh descriptor, dials it with header credentials,
// and copies opaque bytes between OpenSSH standard I/O and the WebSocket.
func ProxySession(
	ctx context.Context,
	creator SessionCreator,
	dialer SessionDialer,
	alias string,
	stdin io.Reader,
	stdout io.Writer,
) error {
	parsed, err := ParseSessionAlias(alias)
	if err != nil {
		return err
	}
	session, err := creator.CreateSSHSession(parsed.ID)
	if err != nil {
		return err
	}
	if err := session.Validate(parsed.ID); err != nil {
		return err
	}
	stream, err := dialer.Dial(ctx, session.ConnectURL, session.ConnectCredential)
	if err != nil {
		return errors.New("failed to connect direct SSH transport")
	}
	defer stream.Close()

	type result struct{ err error }
	results := make(chan result, 2)
	go func() {
		buffer := make([]byte, proxyCopyBufferBytes)
		_, copyErr := io.CopyBuffer(stream, stdin, buffer)
		results <- result{err: copyErr}
	}()
	go func() {
		buffer := make([]byte, proxyCopyBufferBytes)
		_, copyErr := io.CopyBuffer(stdout, stream, buffer)
		results <- result{err: copyErr}
	}()
	first := <-results
	_ = stream.Close()
	second := <-results
	if !expectedStreamClose(first.err) {
		return errors.New("direct SSH transport closed unexpectedly")
	}
	if !expectedStreamClose(second.err) {
		return errors.New("direct SSH transport closed unexpectedly")
	}
	return nil
}

func expectedStreamClose(err error) bool {
	if err == nil || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return true
	}
	status := websocket.CloseStatus(err)
	return status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}

// WebSocketDialer sends the connect credential only in the Authorization
// header and disables compression for opaque SSH ciphertext.
type WebSocketDialer struct {
	HTTPClient *http.Client
}

// Dial opens one bounded binary WebSocket stream.
func (d WebSocketDialer) Dial(ctx context.Context, connectURL, credential string) (Stream, error) {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+credential)
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(dialCtx, connectURL, &websocket.DialOptions{
		HTTPClient:      d.HTTPClient,
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, errors.New("WebSocket SSH handshake failed")
	}
	return wsstream.New(ctx, connection, 64*1024), nil
}

func safeConfigPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsAny(path, "\r\n\t ")
}

func canonicalHostPublicKey(value string) (string, error) {
	key, _, options, rest, err := cryptossh.ParseAuthorizedKey([]byte(value))
	if err != nil || len(options) != 0 || strings.TrimSpace(string(rest)) != "" || key.Type() != cryptossh.KeyAlgoED25519 {
		return "", ErrHostKeyMismatch
	}
	return strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(key))), nil
}
