// Package apiclient provides an HTTP client for the remote Amika API.
package apiclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

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

// CreateSandboxRequest is the request body for POST /api/sandboxes.
type CreateSandboxRequest struct {
	Name               string `json:"name,omitempty"`
	Provider           string `json:"provider,omitempty"`
	GitHubURL          string `json:"github_url,omitempty"`
	AutoStopInterval   *int   `json:"auto_stop_interval,omitempty"`
	AutoDeleteInterval *int   `json:"auto_delete_interval,omitempty"`
}

// RemoteSandbox represents a sandbox returned by the remote API.
type RemoteSandbox struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	GitHubURL string `json:"github_url"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// ListSandboxes fetches sandboxes from the remote API.
func (c *Client) ListSandboxes() ([]RemoteSandbox, error) {
	var result []RemoteSandbox
	if err := c.doJSON("GET", "/api/sandboxes", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list sandboxes: %w", err)
	}
	return result, nil
}

// CreateSandbox creates a sandbox on the remote API.
func (c *Client) CreateSandbox(req CreateSandboxRequest) (*RemoteSandbox, error) {
	var result RemoteSandbox
	if err := c.doJSON("POST", "/api/sandboxes", req, &result); err != nil {
		return nil, fmt.Errorf("remote create sandbox: %w", err)
	}
	return &result, nil
}

// SSHInfo contains SSH connection details for a remote sandbox.
type SSHInfo struct {
	SSHDestination string `json:"ssh_destination"`
	Token          string `json:"token"`
	ExpiresAt      string `json:"expires_at"`
}

// GetSSH retrieves SSH connection details for a remote sandbox.
func (c *Client) GetSSH(name string) (*SSHInfo, error) {
	var result SSHInfo
	if err := c.doJSON("POST", "/api/sandboxes/"+name+"/ssh", nil, &result); err != nil {
		return nil, fmt.Errorf("remote ssh: %w", err)
	}
	return &result, nil
}

// RevokeSSHRequest is the request body for DELETE /api/sandboxes/{name}/ssh.
type RevokeSSHRequest struct {
	Token string `json:"token"`
}

// RevokeSSH revokes an SSH token for a remote sandbox.
func (c *Client) RevokeSSH(name, token string) error {
	req := RevokeSSHRequest{Token: token}
	if err := c.doJSON("DELETE", "/api/sandboxes/"+name+"/ssh", req, nil); err != nil {
		return fmt.Errorf("remote revoke ssh: %w", err)
	}
	return nil
}

// DeleteSandbox deletes a sandbox on the remote API.
func (c *Client) DeleteSandbox(name string) error {
	if err := c.doJSON("DELETE", "/api/sandboxes/"+name, nil, nil); err != nil {
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

// CreateSecretRequest is the request body for POST /api/secrets.
type CreateSecretRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Scope string `json:"scope"`
}

// UpdateSecretRequest is the request body for PUT /api/secrets/[id].
type UpdateSecretRequest struct {
	Value string `json:"value"`
}

// ListSecrets fetches user/org-scoped secrets from the remote API.
func (c *Client) ListSecrets() ([]Secret, error) {
	var result []Secret
	if err := c.doJSON("GET", "/api/secrets", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list secrets: %w", err)
	}
	return result, nil
}

// CreateSecret creates a new secret on the remote API.
func (c *Client) CreateSecret(req CreateSecretRequest) error {
	if err := c.doJSON("POST", "/api/secrets", req, nil); err != nil {
		return fmt.Errorf("remote create secret: %w", err)
	}
	return nil
}

// UpdateSecret updates an existing secret on the remote API.
func (c *Client) UpdateSecret(id string, req UpdateSecretRequest) error {
	if err := c.doJSON("PUT", "/api/secrets/"+id, req, nil); err != nil {
		return fmt.Errorf("remote update secret: %w", err)
	}
	return nil
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
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("parsing response: %w", err)
		}
	}
	return nil
}
