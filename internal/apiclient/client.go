// Package apiclient provides an HTTP client for the remote Amika API.
package apiclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// apiBasePath is the URL prefix shared by all v0beta1 endpoints. The CLI
// targets the versioned API surface; older unversioned paths are no longer
// supported.
const apiBasePath = "/api/v0beta1"

// Client calls the remote Amika API with a bearer token.
type Client struct {
	BaseURL     string
	TokenSource TokenSource
	HTTP        *http.Client
}

// NewClient creates a Client for the given base URL and static access token.
func NewClient(baseURL, accessToken string) *Client {
	return NewClientWithTokenSource(baseURL, NewStaticTokenSource(accessToken))
}

// NewClientWithTokenSource creates a Client that obtains its bearer token from the given TokenSource.
func NewClientWithTokenSource(baseURL string, ts TokenSource) *Client {
	return &Client{
		BaseURL:     strings.TrimRight(baseURL, "/"),
		TokenSource: ts,
		HTTP:        &http.Client{Timeout: 30 * time.Second},
	}
}

// CreateSandboxRequest is the request body for POST /api/v0beta1/sandboxes.
type CreateSandboxRequest struct {
	Name               string               `json:"name,omitempty"`
	Provider           string               `json:"provider,omitempty"`
	RepoURL            string               `json:"repo_url,omitempty"`
	AutoStopInterval   *int                 `json:"auto_stop_interval,omitempty"`
	AutoDeleteInterval *int                 `json:"auto_delete_interval,omitempty"`
	EnvVars            map[string]string    `json:"env_vars,omitempty"`
	SecretEnvVars      map[string]string    `json:"secret_env_vars,omitempty"`
	Preset             string               `json:"preset,omitempty"`
	Size               string               `json:"size,omitempty"`
	SetupScriptText    string               `json:"setup_script_text,omitempty"`
	AgentCredentials   []AgentCredentialRef `json:"agent_credentials,omitempty"`
	Branch             string               `json:"branch,omitempty"`
	NewBranchName      string               `json:"new_branch_name,omitempty"`
}

// AgentCredentialRef selects which credential of a given kind the server
// should inject into a sandbox. An entry with only Kind set is the opt-in
// signal asking the server to walk repo-config defaults / auto-default.
// None=true is the explicit "do not inject" signal.
type AgentCredentialRef struct {
	Kind string `json:"kind"`
	Name string `json:"name,omitempty"`
	Type string `json:"type,omitempty"` // "oauth" or "api_key"
	None bool   `json:"none,omitempty"`
}

// ResolvedAgentCredential is one entry in RemoteSandbox.ResolvedAgentCredentials,
// describing how the server resolved a single agent_credentials request.
type ResolvedAgentCredential struct {
	Kind    string `json:"kind"`
	Outcome string `json:"outcome"` // "resolved" or "skipped"
	Name    string `json:"name,omitempty"`
	Type    string `json:"type,omitempty"`
	Source  string `json:"source,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// RemoteSandbox represents a sandbox returned by the remote API.
type RemoteSandbox struct {
	ID                       string                    `json:"id"`
	Name                     string                    `json:"name"`
	Provider                 string                    `json:"provider"`
	RepoURL                  string                    `json:"repo_url"`
	State                    string                    `json:"state"`
	CreatedAt                string                    `json:"created_at"`
	Branch                   string                    `json:"branch"`
	ErrorMessage             string                    `json:"error_message"`
	ResolvedAgentCredentials []ResolvedAgentCredential `json:"resolved_agent_credentials,omitempty"`
}

// ListSandboxes fetches sandboxes from the remote API.
func (c *Client) ListSandboxes() ([]RemoteSandbox, error) {
	var result []RemoteSandbox
	if err := c.doJSON("GET", apiBasePath+"/sandboxes", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list sandboxes: %w", err)
	}
	return result, nil
}

// CreateSandbox creates a sandbox on the remote API.
// The endpoint returns 202 Accepted with the sandbox in "initializing" state.
// Use GetSandbox or WaitForSandbox to poll until provisioning completes.
func (c *Client) CreateSandbox(req CreateSandboxRequest) (*RemoteSandbox, error) {
	var result RemoteSandbox
	if err := c.doJSON("POST", apiBasePath+"/sandboxes", req, &result); err != nil {
		return nil, fmt.Errorf("remote create sandbox: %w", err)
	}
	return &result, nil
}

// GetSandbox fetches a single sandbox by name from the remote API.
func (c *Client) GetSandbox(name string) (*RemoteSandbox, error) {
	var result RemoteSandbox
	if err := c.doJSON("GET", apiBasePath+"/sandboxes/"+url.PathEscape(name), nil, &result); err != nil {
		return nil, fmt.Errorf("remote get sandbox: %w", err)
	}
	return &result, nil
}

// waitForSandboxState polls GET /api/sandboxes/{name} every 3 seconds until
// the sandbox state matches one of readyStates or "failed".
func (c *Client) waitForSandboxState(name string, readyStates []string, failMsg string) (*RemoteSandbox, error) {
	for {
		sb, err := c.GetSandbox(name)
		if err != nil {
			return nil, err
		}
		if sb.State == "failed" {
			if sb.ErrorMessage != "" {
				return sb, fmt.Errorf("%s", sb.ErrorMessage)
			}
			return sb, fmt.Errorf("%s", failMsg)
		}
		for _, s := range readyStates {
			if sb.State == s {
				return sb, nil
			}
		}
		time.Sleep(3 * time.Second)
	}
}

// WaitForSandbox polls GET /api/sandboxes/{name} until the sandbox reaches
// a ready or terminal state. It polls every 3 seconds.
func (c *Client) WaitForSandbox(name string) (*RemoteSandbox, error) {
	return c.waitForSandboxState(name, []string{"active", "running", "started"}, "sandbox provisioning failed")
}

// SSHInfo contains SSH connection details for a remote sandbox.
type SSHInfo struct {
	SSHDestination string `json:"ssh_destination"`
	Token          string `json:"token"`
	ExpiresAt      string `json:"expires_at"`
	RepoName       string `json:"repo_name"`
}

// GetSSH retrieves SSH connection details for a remote sandbox.
func (c *Client) GetSSH(name string) (*SSHInfo, error) {
	var result SSHInfo
	if err := c.doJSON("POST", apiBasePath+"/sandboxes/"+url.PathEscape(name)+"/ssh", nil, &result); err != nil {
		return nil, fmt.Errorf("remote ssh: %w", err)
	}
	return &result, nil
}

// RevokeSSHRequest is the request body for DELETE /api/v0beta1/sandboxes/{id}/ssh.
type RevokeSSHRequest struct {
	Token string `json:"token"`
}

// RevokeSSH revokes an SSH token for a remote sandbox.
func (c *Client) RevokeSSH(name, token string) error {
	req := RevokeSSHRequest{Token: token}
	if err := c.doJSON("DELETE", apiBasePath+"/sandboxes/"+url.PathEscape(name)+"/ssh", req, nil); err != nil {
		return fmt.Errorf("remote revoke ssh: %w", err)
	}
	return nil
}

// StartSandbox starts (resumes) a sandbox on the remote API.
// The endpoint returns 202 Accepted with the sandbox in "initializing" state.
// Use WaitForSandboxStart to poll until the sandbox is active.
func (c *Client) StartSandbox(name string) error {
	if err := c.doJSON("POST", apiBasePath+"/sandboxes/"+url.PathEscape(name)+"/start", nil, nil); err != nil {
		return fmt.Errorf("remote start sandbox: %w", err)
	}
	return nil
}

// WaitForSandboxStart polls GET /api/sandboxes/{name} until the sandbox
// transitions out of "initializing" state. It polls every 3 seconds.
func (c *Client) WaitForSandboxStart(name string) (*RemoteSandbox, error) {
	return c.waitForSandboxState(name, []string{"active", "running", "started"}, "sandbox start failed")
}

// StopSandbox stops a sandbox on the remote API.
// The endpoint returns 202 Accepted with the sandbox in "stopping" state.
// Use WaitForSandboxStop to poll until the sandbox is stopped.
func (c *Client) StopSandbox(name string) error {
	if err := c.doJSON("POST", apiBasePath+"/sandboxes/"+url.PathEscape(name)+"/stop", nil, nil); err != nil {
		return fmt.Errorf("remote stop sandbox: %w", err)
	}
	return nil
}

// WaitForSandboxStop polls GET /api/sandboxes/{name} until the sandbox
// transitions out of "stopping" state. It polls every 3 seconds.
func (c *Client) WaitForSandboxStop(name string) (*RemoteSandbox, error) {
	return c.waitForSandboxState(name, []string{"stopped"}, "sandbox stop failed")
}

// DeleteSandbox deletes a sandbox on the remote API.
func (c *Client) DeleteSandbox(name string) error {
	if err := c.doJSON("DELETE", apiBasePath+"/sandboxes/"+url.PathEscape(name), nil, nil); err != nil {
		return fmt.Errorf("remote delete sandbox: %w", err)
	}
	return nil
}

// Secret represents a secret returned by the remote API.
type Secret struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Scope string `json:"scope"`
}

// CreateSecretRequest is the request body for POST /api/v0beta1/secrets.
type CreateSecretRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Scope string `json:"scope"`
}

// UpdateSecretRequest is the request body for PUT /api/v0beta1/secrets/[id].
type UpdateSecretRequest struct {
	Value string `json:"value"`
}

// ListSecrets fetches user/org-scoped secrets from the remote API.
func (c *Client) ListSecrets() ([]Secret, error) {
	var result []Secret
	if err := c.doJSON("GET", apiBasePath+"/secrets", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list secrets: %w", err)
	}
	return result, nil
}

// CreateSecret creates a new secret on the remote API.
func (c *Client) CreateSecret(req CreateSecretRequest) error {
	if err := c.doJSON("POST", apiBasePath+"/secrets", req, nil); err != nil {
		return fmt.Errorf("remote create secret: %w", err)
	}
	return nil
}

// UpdateSecret updates an existing secret on the remote API.
func (c *Client) UpdateSecret(id string, req UpdateSecretRequest) error {
	if err := c.doJSON("PUT", apiBasePath+"/secrets/"+id, req, nil); err != nil {
		return fmt.Errorf("remote update secret: %w", err)
	}
	return nil
}

// CreateProviderSecretRequest is the request body for
// POST /api/v0beta1/secrets/<provider>. Shared by provider-scoped credential
// endpoints (e.g. Claude, Codex).
type CreateProviderSecretRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Type  string `json:"type"` // "oauth" or "api_key" — required by the server
}

// ProviderSecretSummary is the response from POST /api/v0beta1/secrets/<provider>.
type ProviderSecretSummary struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Scope string `json:"scope"`
}

// ProviderSecretListItem is an item in the GET /api/v0beta1/secrets/<provider>
// response.
type ProviderSecretListItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// CreateProviderSecret uploads provider-scoped credentials (e.g. Claude,
// Codex) to the remote API. provider is the URL segment
// ("claude", "codex").
func (c *Client) CreateProviderSecret(provider string, req CreateProviderSecretRequest) (*ProviderSecretSummary, error) {
	var result ProviderSecretSummary
	if err := c.doJSON("POST", apiBasePath+"/secrets/"+provider, req, &result); err != nil {
		return nil, fmt.Errorf("remote create %s secret: %w", provider, err)
	}
	return &result, nil
}

// ListProviderSecrets lists provider-scoped credentials for the current user.
func (c *Client) ListProviderSecrets(provider string) ([]ProviderSecretListItem, error) {
	var result []ProviderSecretListItem
	if err := c.doJSON("GET", apiBasePath+"/secrets/"+provider, nil, &result); err != nil {
		return nil, fmt.Errorf("remote list %s secrets: %w", provider, err)
	}
	return result, nil
}

// DeleteProviderSecret deletes a provider-scoped credential by ID. provider is
// the URL segment ("claude", "codex").
func (c *Client) DeleteProviderSecret(provider, id string) error {
	if err := c.doJSON("DELETE", apiBasePath+"/secrets/"+provider+"/"+id, nil, nil); err != nil {
		return fmt.Errorf("remote delete %s secret: %w", provider, err)
	}
	return nil
}

// AgentSendRequest is the request body for POST /api/v0beta1/sandboxes/{id}/agent-send.
type AgentSendRequest struct {
	Message    string `json:"message"`
	NewSession bool   `json:"new_session,omitempty"`
	SessionID  string `json:"session_id,omitempty"`
	Agent      string `json:"agent,omitempty"`
}

// AgentSendResponse is the response from POST /api/v0beta1/sandboxes/{id}/agent-send.
type AgentSendResponse struct {
	Result    string `json:"response"`
	SessionID string `json:"session_id"`
	IsError   bool   `json:"is_error"`
}

// AgentSend sends a message to an agent inside a remote sandbox.
// The endpoint is synchronous: it blocks until the agent finishes, so a
// longer HTTP timeout (10 minutes) is used instead of the default 30 seconds.
func (c *Client) AgentSend(sandboxName string, req AgentSendRequest) (*AgentSendResponse, error) {
	saved := c.HTTP.Timeout
	c.HTTP.Timeout = 10 * time.Minute
	defer func() { c.HTTP.Timeout = saved }()

	var result AgentSendResponse
	if err := c.doJSON("POST", apiBasePath+"/sandboxes/"+url.PathEscape(sandboxName)+"/agent-send", req, &result); err != nil {
		if authErr := extractAgentAuthError(err); authErr != "" {
			return nil, fmt.Errorf("remote agent-send: agent failed to authenticate with its AI provider: %s\n\nthe sandbox agent's API credentials may have expired or been revoked; recreate the sandbox or update its API keys to restore access", authErr)
		}
		return nil, fmt.Errorf("remote agent-send: %w", err)
	}
	return &result, nil
}

// Session represents an agent session on a remote sandbox.
type Session struct {
	ID        string                 `json:"id"`
	SandboxID string                 `json:"sandbox_id"`
	OrgID     string                 `json:"org_id"`
	AgentName string                 `json:"agent_name"`
	Status    string                 `json:"status"`
	StartedAt string                 `json:"started_at"`
	EndedAt   *string                `json:"ended_at"`
	Metadata  map[string]interface{} `json:"metadata"`
	CreatedAt string                 `json:"created_at"`
	UpdatedAt string                 `json:"updated_at"`
}

// CreateSessionRequest is the request body for POST /api/v0beta1/sandboxes/{id}/sessions.
type CreateSessionRequest struct {
	AgentName string                 `json:"agent_name"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
}

// UpdateSessionRequest is the request body for PATCH /api/v0beta1/sandboxes/{id}/sessions/{sessionId}.
type UpdateSessionRequest struct {
	Status   string                 `json:"status,omitempty"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// CreateSession creates a new agent session on a remote sandbox.
func (c *Client) CreateSession(sandboxName string, req CreateSessionRequest) (*Session, error) {
	var result Session
	if err := c.doJSON("POST", apiBasePath+"/sandboxes/"+url.PathEscape(sandboxName)+"/sessions", req, &result); err != nil {
		return nil, fmt.Errorf("remote create session: %w", err)
	}
	return &result, nil
}

// ListSessions lists agent sessions for a remote sandbox.
func (c *Client) ListSessions(sandboxName string) ([]Session, error) {
	var envelope struct {
		Sessions []Session `json:"sessions"`
		Total    int       `json:"total"`
	}
	if err := c.doJSON("GET", apiBasePath+"/sandboxes/"+url.PathEscape(sandboxName)+"/sessions", nil, &envelope); err != nil {
		return nil, fmt.Errorf("remote list sessions: %w", err)
	}
	return envelope.Sessions, nil
}

// GetLatestSession returns the most recent session for a remote sandbox.
// Returns nil, nil if no session exists (HTTP 404).
func (c *Client) GetLatestSession(sandboxName string) (*Session, error) {
	var result Session
	if err := c.doJSON("GET", apiBasePath+"/sandboxes/"+url.PathEscape(sandboxName)+"/sessions/latest", nil, &result); err != nil {
		if strings.Contains(err.Error(), "HTTP 404") {
			return nil, nil
		}
		return nil, fmt.Errorf("remote get latest session: %w", err)
	}
	return &result, nil
}

// GetSession returns a specific session by ID.
func (c *Client) GetSession(sandboxName, sessionID string) (*Session, error) {
	var result Session
	if err := c.doJSON("GET", apiBasePath+"/sandboxes/"+url.PathEscape(sandboxName)+"/sessions/"+url.PathEscape(sessionID), nil, &result); err != nil {
		return nil, fmt.Errorf("remote get session: %w", err)
	}
	return &result, nil
}

// UpdateSession updates a session on a remote sandbox.
func (c *Client) UpdateSession(sandboxName, sessionID string, req UpdateSessionRequest) (*Session, error) {
	var result Session
	if err := c.doJSON("PATCH", apiBasePath+"/sandboxes/"+url.PathEscape(sandboxName)+"/sessions/"+url.PathEscape(sessionID), req, &result); err != nil {
		return nil, fmt.Errorf("remote update session: %w", err)
	}
	return &result, nil
}

func (c *Client) doJSON(method, path string, body interface{}, out interface{}) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshalling request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, bodyReader)
	if err != nil {
		return err
	}
	token, err := c.TokenSource.Token()
	if err != nil {
		return fmt.Errorf("obtaining auth token: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("parsing response: %w", err)
		}
	}
	return nil
}
