package apiclient

import "errors"

// ErrSSHSessionNotImplemented marks the fail-closed direct-session client stub.
var ErrSSHSessionNotImplemented = errors.New("SSH session API is not implemented")

// SSHSession is the transport descriptor returned for one SSH dial.
type SSHSession struct {
	SessionID         string `json:"session_id"`
	Transport         string `json:"transport"`
	ConnectURL        string `json:"connect_url"`
	ConnectCredential string `json:"connect_credential"`
	SandboxID         string `json:"sandbox_id"`
	SSHUser           string `json:"ssh_user"`
	HostPublicKey     string `json:"host_public_key"`
}

// CreateSSHSession fails closed until the v2 API contract is implemented.
func (c *Client) CreateSSHSession(_ string) (*SSHSession, error) {
	_ = c
	return nil, ErrSSHSessionNotImplemented
}
