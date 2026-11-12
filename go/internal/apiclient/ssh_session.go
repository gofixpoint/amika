package apiclient

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"

	cryptossh "golang.org/x/crypto/ssh"
)

// ErrInvalidSSHSession marks an unsafe or internally inconsistent descriptor.
var ErrInvalidSSHSession = errors.New("invalid SSH session descriptor")

// SSHSessionTransport selects how the stdio proxy reaches the sandbox.
type SSHSessionTransport string

const (
	// SSHSessionTransportDirectWS is the provider-exposed no-relay transport.
	SSHSessionTransportDirectWS SSHSessionTransport = "direct_ws"
	// SSHSessionTransportIroh reaches amikad through `amika-net connect` to
	// the rig's host. Its descriptor carries the direct_ws route too, as the
	// fallback.
	SSHSessionTransportIroh SSHSessionTransport = "iroh"
)

// ErrSSHTransportUnavailable marks a create request that listed no
// transport the control plane can give for the rig: the API's
// `409 ssh_transport_unavailable`.
var ErrSSHTransportUnavailable = errors.New("SSH transport unavailable")

// SSHSession is the transport descriptor returned for one SSH dial.
type SSHSession struct {
	SessionID         string              `json:"session_id"`
	Transport         SSHSessionTransport `json:"transport"`
	ConnectURL        string              `json:"connect_url"`
	ConnectCredential string              `json:"connect_credential"`
	SandboxID         string              `json:"sandbox_id"`
	SSHUser           string              `json:"ssh_user"`
	HostPublicKey     string              `json:"host_public_key"`
	// SSHResume is the control plane's switch for end-to-end SSH resume. Nil
	// (an older control plane) and true dial amikad's /v2 route; false dials
	// /v1 at once.
	SSHResume *bool `json:"ssh_resume,omitempty"`
	// Iroh is where to dial the rig's host over iroh. It is set exactly when
	// Transport is iroh.
	Iroh *SSHSessionIroh `json:"iroh,omitempty"`
}

// SSHSessionIroh is the iroh part of an iroh descriptor: the stream target
// `rig:<RigID>:<Port>` on the host endpoint EndpointID.
type SSHSessionIroh struct {
	// EndpointID is the host's iroh endpoint id: its Ed25519 public key as
	// 64 lowercase hex characters.
	EndpointID string `json:"endpoint_id"`
	// RelayURL is the host's home relay. The control plane never sends an
	// iroh descriptor without one. Nil still decodes, and leaves only the
	// descriptor's direct_ws route usable: the proxy uses that and logs
	// why.
	RelayURL *string `json:"relay_url"`
	// RigID is hostd's id for the rig.
	RigID string `json:"rig_id"`
	// Port is amikad's port in the rig.
	Port int `json:"port"`
}

// createSSHSessionRequest is the optional body of the session create call.
type createSSHSessionRequest struct {
	Transports []SSHSessionTransport `json:"transports"`
}

// ResumeEnabled reports whether the proxy should try amikad's resumable
// route first.
func (s *SSHSession) ResumeEnabled() bool { return s.SSHResume == nil || *s.SSHResume }

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
	if s.SandboxID != expectedSandboxID || !ValidSSHUser(s.SSHUser) {
		return ErrInvalidSSHSession
	}
	switch s.Transport {
	case SSHSessionTransportDirectWS:
		if s.Iroh != nil {
			return ErrInvalidSSHSession
		}
	case SSHSessionTransportIroh:
		if s.Iroh == nil || !s.Iroh.valid() {
			return ErrInvalidSSHSession
		}
	default:
		return ErrInvalidSSHSession
	}
	if !isCanonicalConnectToken(s.ConnectCredential) || CanonicalEd25519PublicKey(s.HostPublicKey) == "" {
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

// endpointIDPattern is an iroh endpoint id: an Ed25519 public key in
// lowercase hex.
var endpointIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// rigIDPattern is a rig id that amika-net accepts in a stream target.
var rigIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// valid checks every field that goes into the `amika-net connect` argv.
func (i *SSHSessionIroh) valid() bool {
	if !endpointIDPattern.MatchString(i.EndpointID) || !rigIDPattern.MatchString(i.RigID) || i.Port < 1 || i.Port > 65535 {
		return false
	}
	if i.RelayURL == nil {
		return true
	}
	relay, err := url.Parse(*i.RelayURL)
	return err == nil && len(*i.RelayURL) <= 2048 &&
		(relay.Scheme == "https" || relay.Scheme == "http") &&
		relay.Host != "" && relay.User == nil &&
		!strings.ContainsAny(*i.RelayURL, " \t\r\n")
}

// CreateSSHSession creates and validates a fresh descriptor for one dial.
//
// sandboxID is always a canonical id: one a GetSandbox response returned, or
// one parsed back out of a session alias inside the ProxyCommand. A user's rig
// reference never reaches this call, so it is sent with sandbox_by=id (a plain
// ref would 409 once another rig is named after this id), and the
// descriptor's sandbox_id must equal it.
//
// transports lists the transports this client supports. Nil sends no body,
// which the control plane reads as direct_ws only. The descriptor's
// transport must be one the request allowed. A refusal because none of them
// is available for the rig wraps ErrSSHTransportUnavailable.
func (c *Client) CreateSSHSession(sandboxID string, transports []SSHSessionTransport) (*SSHSession, error) {
	var result SSHSession
	path := sandboxPath(SandboxByID(sandboxID), "sandbox_by", "/ssh-sessions", nil)
	var body any
	if transports != nil {
		body = createSSHSessionRequest{Transports: transports}
	}
	if err := c.doJSON("POST", path, body, &result); err != nil {
		var httpErr *HTTPError
		if errors.As(err, &httpErr) && httpErr.StatusCode == 409 && httpErr.Code() == "ssh_transport_unavailable" {
			return nil, fmt.Errorf("%w: %s", ErrSSHTransportUnavailable, httpErr.message())
		}
		return nil, fmt.Errorf("remote create SSH session: %w", err)
	}
	if err := result.Validate(sandboxID); err != nil {
		return nil, err
	}
	allowed := transports
	if allowed == nil {
		allowed = []SSHSessionTransport{SSHSessionTransportDirectWS}
	}
	if !slices.Contains(allowed, result.Transport) {
		return nil, ErrInvalidSSHSession
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
	key, _, options, rest, err := cryptossh.ParseAuthorizedKey([]byte(value))
	if err != nil || len(options) != 0 || strings.TrimSpace(string(rest)) != "" || key.Type() != cryptossh.KeyAlgoED25519 {
		return ""
	}
	return strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(key)))
}
