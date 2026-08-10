package apiclient

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"

	cryptossh "golang.org/x/crypto/ssh"
)

// ErrInvalidSSHSession marks an unsafe or internally inconsistent descriptor.
var ErrInvalidSSHSession = errors.New("invalid SSH session descriptor")

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

// CreateSSHPublicKeyRequest uploads one user-owned public key.
type CreateSSHPublicKeyRequest struct {
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
}

// SSHPublicKeySummary is the non-secret key metadata returned by the API.
type SSHPublicKeySummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
	Scope     string `json:"scope"`
}

// Validate checks every field used by OpenSSH or the WebSocket dialer.
func (s *SSHSession) Validate(expectedSandboxID string) error {
	if s.SessionID == "" || len(s.SessionID) > 128 || !strings.HasPrefix(s.SessionID, "sshs_") {
		return ErrInvalidSSHSession
	}
	if s.Transport != SSHSessionTransportDirectWS || s.SandboxID != expectedSandboxID || s.SSHUser != "amika" {
		return ErrInvalidSSHSession
	}
	if !isCanonicalConnectToken(s.ConnectCredential) || canonicalEd25519Key(s.HostPublicKey) == "" {
		return ErrInvalidSSHSession
	}
	connectURL, err := url.Parse(s.ConnectURL)
	if err != nil || connectURL.Scheme != "wss" || connectURL.Host == "" || connectURL.User != nil || connectURL.RawQuery != "" || connectURL.Fragment != "" {
		return ErrInvalidSSHSession
	}
	if !strings.HasSuffix(connectURL.EscapedPath(), "/v1/ssh-sessions") {
		return ErrInvalidSSHSession
	}
	return nil
}

// CreateSSHSession creates and validates a fresh descriptor for one dial.
func (c *Client) CreateSSHSession(sandboxID string) (*SSHSession, error) {
	var result SSHSession
	path := apiBasePath + "/sandboxes/" + url.PathEscape(sandboxID) + "/ssh-sessions"
	if err := c.doJSON("POST", path, nil, &result); err != nil {
		return nil, fmt.Errorf("remote create SSH session: %w", err)
	}
	if err := result.Validate(sandboxID); err != nil {
		return nil, err
	}
	return &result, nil
}

// CreateSSHPublicKey stores a user-scoped SSH public key.
func (c *Client) CreateSSHPublicKey(request CreateSSHPublicKeyRequest) (*SSHPublicKeySummary, error) {
	var result SSHPublicKeySummary
	if err := c.doJSON("POST", apiBasePath+"/secrets/ssh-public-keys", request, &result); err != nil {
		return nil, fmt.Errorf("remote create SSH public key: %w", err)
	}
	return &result, nil
}

// ListSSHPublicKeys returns the caller's user-scoped SSH public keys.
func (c *Client) ListSSHPublicKeys() ([]SSHPublicKeySummary, error) {
	var result []SSHPublicKeySummary
	if err := c.doJSON("GET", apiBasePath+"/secrets/ssh-public-keys", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list SSH public keys: %w", err)
	}
	return result, nil
}

// DeleteSSHPublicKey removes one of the caller's SSH public keys by id.
func (c *Client) DeleteSSHPublicKey(id string) error {
	path := apiBasePath + "/secrets/ssh-public-keys/" + url.PathEscape(id)
	if err := c.doJSON("DELETE", path, nil, nil); err != nil {
		return fmt.Errorf("remote delete SSH public key: %w", err)
	}
	return nil
}

func isCanonicalConnectToken(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == value
}

// CanonicalEd25519PublicKey validates one OpenSSH ed25519 public key line and
// returns it in canonical form with any comment stripped, or "" if the value
// is not a well-formed ed25519 key. The control plane canonicalizes the same
// way, so uploading this form keeps a locally read key byte-identical to what
// the server stores.
func CanonicalEd25519PublicKey(value string) string {
	return canonicalEd25519Key(value)
}

func canonicalEd25519Key(value string) string {
	key, _, options, rest, err := cryptossh.ParseAuthorizedKey([]byte(value))
	if err != nil || len(options) != 0 || strings.TrimSpace(string(rest)) != "" || key.Type() != cryptossh.KeyAlgoED25519 {
		return ""
	}
	return strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(key)))
}
