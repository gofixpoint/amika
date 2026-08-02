package apiclient

import "errors"

// ErrSSHSessionNotImplemented marks the fail-closed direct-session client stub.
var ErrSSHSessionNotImplemented = errors.New("SSH session API is not implemented")

// SSHSessionTransport selects how the stdio proxy reaches the sandbox.
type SSHSessionTransport string

// SSHSessionTransportDirectWS is the provider-exposed no-relay transport.
const SSHSessionTransportDirectWS SSHSessionTransport = "direct_ws"

// SSHSession is the transport descriptor returned for one SSH dial.
type SSHSession struct {
	SessionID         string              `json:"session_id"`
	Transport         SSHSessionTransport `json:"transport"`
	ConnectURL        string              `json:"connect_url"`
	ConnectCredential string              `json:"connect_credential"`
	SandboxID         string              `json:"sandbox_id"`
	SSHUser           string              `json:"ssh_user"`
	HostPublicKey     string              `json:"host_public_key"`
}

// Validate fails closed until descriptor validation is implemented.
func (s *SSHSession) Validate(_ string) error {
	_ = s
	return ErrSSHSessionNotImplemented
}

// CreateSSHSession fails closed until the v2 API contract is implemented.
func (c *Client) CreateSSHSession(_ string) (*SSHSession, error) {
	_ = c
	return nil, ErrSSHSessionNotImplemented
}
