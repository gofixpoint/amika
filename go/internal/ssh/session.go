package ssh

import (
	"context"
	"errors"
	"io"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

// ErrSessionTransportNotImplemented marks the fail-closed v2 SSH client stub.
var ErrSessionTransportNotImplemented = errors.New("SSH session transport is not implemented")

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

// BuildSessionAlias fails closed until the v2 alias rules are implemented.
func BuildSessionAlias(_, _ string) (string, error) {
	return "", ErrSessionTransportNotImplemented
}

// ParseSessionAlias fails closed until right-to-left alias parsing is implemented.
func ParseSessionAlias(_ string) (SandboxAlias, error) {
	return SandboxAlias{}, ErrSessionTransportNotImplemented
}

// RenderSessionConfig fails closed until strict host-key configuration lands.
func RenderSessionConfig(_ SessionConfig) (string, error) {
	return "", ErrSessionTransportNotImplemented
}

// KnownHostLine fails closed until alias-keyed host pinning lands.
func KnownHostLine(_, _ string) (string, error) {
	return "", ErrSessionTransportNotImplemented
}

// ProxySession fails before creating a session, dialing, or copying standard IO.
func ProxySession(
	_ context.Context,
	_ SessionCreator,
	_ SessionDialer,
	_ string,
	_ io.Reader,
	_ io.Writer,
) error {
	return ErrSessionTransportNotImplemented
}
