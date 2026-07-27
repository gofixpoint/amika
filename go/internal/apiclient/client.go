// Package apiclient provides an HTTP client for the remote Amika API.
package apiclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
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
	GithubAuthMode     string               `json:"github_auth_mode,omitempty"`
	// Snapshot forks the new sandbox from a captured snapshot slug (remote
	// only). nil omits the field so the server applies its default snapshot
	// chain (repo default, else preset/size); a non-nil value boots from that
	// snapshot. The server also accepts an explicit JSON null to opt out of the
	// repo-level default, but a *string with omitempty cannot encode that (nil
	// omits rather than nulls), so the opt-out is not reachable from here.
	Snapshot *string `json:"snapshot,omitempty"`
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

// RemoteSandboxService is one named service exposed by a remote sandbox: a
// published port with an optional generated URL. It mirrors the server's
// sandbox `services` entries. For remote sandboxes HostPort and ContainerPort
// are typically equal (the provider maps the container port through), and URL
// is the externally reachable address.
type RemoteSandboxService struct {
	Name          string `json:"name"`
	URL           string `json:"url"`
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"`
}

// RemoteSandbox mirrors the API's Sandbox schema (see
// /api/v0beta1/sandboxes and the "Sandbox" component schema in the API's
// OpenAPI document, served at /api/openapi.json).
// It is the single decode/encode type: the CLI decodes API responses into it
// and re-encodes the same value for `-o json`, so the two stay byte-for-byte
// shaped the same (round-trip fidelity).
//
// Fields the schema marks `nullable: true` are Go pointers so JSON `null` is
// emitted rather than the field being omitted; fields the schema marks
// `required` are always present in the encoded output (no `omitempty`).
// Non-required fields may use `omitempty`.
//
// ContainerID and Image have no equivalent in the API schema. They are local
// CLI extensions populated only for Docker sandboxes (see
// sandboxcmd.remoteSandboxFromInfo / remoteSandboxFromPublic); the schema's
// `additionalProperties: {nullable:true}` allows extra keys, so they still
// validate against the documented shape.
type RemoteSandbox struct {
	// --- required fields (schema "required": always present, never omitted) ---

	ID                string                 `json:"id"`
	UserID            *string                `json:"user_id"`
	OrgID             string                 `json:"org_id"`
	Name              string                 `json:"name"`
	Provider          *string                `json:"provider"`
	ProviderSandboxID *string                `json:"provider_sandbox_id"`
	ProviderURL       *string                `json:"provider_url"`
	AmikaOpencodeWeb  *string                `json:"amika_opencode_web"`
	RepoName          *string                `json:"repo_name"`
	RepoProvider      *string                `json:"repo_provider"`
	RepoID            *string                `json:"repo_id"`
	RepoURL           *string                `json:"repo_url"`
	Branch            *string                `json:"branch"`
	CommitHash        *string                `json:"commit_hash"`
	Snapshot          *string                `json:"snapshot"`
	CurrentSessionID  *string                `json:"current_session_id"`
	Services          []RemoteSandboxService `json:"services"`
	CreatedAt         string                 `json:"created_at"`
	UpdatedAt         string                 `json:"updated_at"`

	// --- non-required fields (omitempty allowed) ---

	SnapshotName             *string                   `json:"snapshot_name,omitempty"`
	SandboxPreset            *string                   `json:"sandbox_preset,omitempty"`
	SandboxSize              *string                   `json:"sandbox_size,omitempty"`
	ErrorMessage             *string                   `json:"error_message,omitempty"`
	State                    string                    `json:"state,omitempty"`
	Status                   string                    `json:"status,omitempty"`
	SetupStatus              *string                   `json:"setup_status,omitempty"`
	URLsExpireAt             *string                   `json:"urls_expire_at,omitempty"`
	SecretNames              []string                  `json:"secret_names,omitempty"`
	HasWorkflow              bool                      `json:"has_workflow,omitempty"`
	ResolvedAgentCredentials []ResolvedAgentCredential `json:"resolved_agent_credentials,omitempty"`
	CreatedBy                *RemoteSandboxCreator     `json:"created_by,omitempty"`
	Origin                   *string                   `json:"origin,omitempty"`

	// --- local CLI extensions (no API equivalent; see doc comment above) ---

	ContainerID string `json:"container_id,omitempty"`
	Image       string `json:"image,omitempty"`
}

// RemoteSandboxCreator describes the human who created a remote sandbox, as
// returned by the API. Either field may be null if the server could not
// resolve the user (deleted account, API-key principal, or noop auth mode).
type RemoteSandboxCreator struct {
	Name  *string `json:"name"`
	Email *string `json:"email"`
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

// pollInterval is the delay between polls in the WaitForSandbox* loops.
// It is a package var (not a constant) so tests can shrink it to keep the
// suite fast; production always uses the 3 second default.
var pollInterval = 3 * time.Second

// waitForSandboxState polls GET /api/v0beta1/sandboxes/{name} every pollInterval
// until the sandbox state matches one of readyStates or "failed".
func (c *Client) waitForSandboxState(name string, readyStates []string, failMsg string) (*RemoteSandbox, error) {
	for {
		sb, err := c.GetSandbox(name)
		if err != nil {
			return nil, err
		}
		if sb.State == "failed" {
			if sb.ErrorMessage != nil && *sb.ErrorMessage != "" {
				return sb, fmt.Errorf("%s", *sb.ErrorMessage)
			}
			return sb, fmt.Errorf("%s", failMsg)
		}
		for _, s := range readyStates {
			if sb.State == s {
				return sb, nil
			}
		}
		time.Sleep(pollInterval)
	}
}

// WaitForSandbox polls GET /api/v0beta1/sandboxes/{name} until the sandbox reaches
// a ready or terminal state. It polls every 3 seconds.
func (c *Client) WaitForSandbox(name string) (*RemoteSandbox, error) {
	return c.waitForSandboxState(name, []string{"active", "running", "started"}, "sandbox provisioning failed")
}

// SSHInfo contains SSH connection details for a remote sandbox.
type SSHInfo struct {
	SSHDestination string `json:"ssh_destination"`
	Token          string `json:"token"`
	ExpiresAt      string `json:"expires_at"`
	// SandboxID is the sandbox's immutable identifier. It is used to key a
	// stable SSH host alias so an editor's Remote-SSH session re-links across
	// reconnects rather than treating each rotated token as a new host. It may
	// be empty when talking to an older server that predates this field.
	SandboxID   string `json:"sandbox_id"`
	SandboxName string `json:"sandbox_name"`
	RepoName    string `json:"repo_name"`
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

// WaitForSandboxStart polls GET /api/v0beta1/sandboxes/{name} until the sandbox
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

// WaitForSandboxStop polls GET /api/v0beta1/sandboxes/{name} until the sandbox
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

// RemoteRepository represents a repository returned by
// GET /api/v0beta1/repositories.
type RemoteRepository struct {
	ID      string `json:"id"`
	RepoURL string `json:"repo_url"`
}

// ListRepositories fetches the org's repositories from the remote API.
func (c *Client) ListRepositories() ([]RemoteRepository, error) {
	var result []RemoteRepository
	if err := c.doJSON("GET", apiBasePath+"/repositories", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list repositories: %w", err)
	}
	return result, nil
}

// SandboxSnapshot mirrors the API's SandboxSnapshot schema, as returned by the
// /api/v0beta1/sandbox-snapshots endpoints. All fields are required by the
// schema, so none are `omitempty`; nullable fields are pointers so `null` is
// emitted rather than omitted (see RemoteSandbox's doc comment for the same
// round-trip-fidelity convention).
type SandboxSnapshot struct {
	ID                string                       `json:"id"`
	Snapshot          string                       `json:"snapshot"`
	Provider          string                       `json:"provider"`
	Description       *string                      `json:"description"`
	SourceSandboxID   *string                      `json:"source_sandbox_id"`
	SourceSandboxName *string                      `json:"source_sandbox_name"`
	RepositoryID      *string                      `json:"repository_id"`
	RepositoryURL     *string                      `json:"repository_url"`
	BaseSnapshot      *string                      `json:"base_snapshot"`
	SandboxPreset     *string                      `json:"sandbox_preset"`
	SandboxSize       *string                      `json:"sandbox_size"`
	CaptureMode       *string                      `json:"capture_mode"`
	State             string                       `json:"state"`
	ErrorMessage      *string                      `json:"error_message"`
	CreatedAt         string                       `json:"created_at"`
	UpdatedAt         string                       `json:"updated_at"`
	Daytona           *ExperimentalDaytonaSnapshot `json:"daytona"`
}

// ListSandboxSnapshotsResponse mirrors the API's ListSandboxSnapshotsResponse
// schema, the response body of GET /api/v0beta1/sandbox-snapshots: an object
// with a single required `items` array, not a bare array (unlike
// ListSandboxesResponse/ListSecretsResponse). Items is never omitted so an
// empty result still emits `{"items":[]}` rather than `{"items":null}`.
type ListSandboxSnapshotsResponse struct {
	Items []SandboxSnapshot `json:"items"`
}

// ExperimentalDaytonaSnapshot mirrors the API's ExperimentalDaytonaSnapshot
// schema: provider-specific Daytona snapshot detail nested under
// SandboxSnapshot.Daytona. Only Name is required by the schema.
type ExperimentalDaytonaSnapshot struct {
	Name      string  `json:"name"`
	State     string  `json:"state,omitempty"`
	ImageName string  `json:"imageName,omitempty"`
	CPU       float64 `json:"cpu,omitempty"`
	Memory    float64 `json:"memory,omitempty"`
	Disk      float64 `json:"disk,omitempty"`
	CreatedAt string  `json:"createdAt,omitempty"`
	UpdatedAt string  `json:"updatedAt,omitempty"`
}

// CreateSandboxSnapshotRequest is the request body for
// POST /api/v0beta1/sandbox-snapshots. SandboxRef references the source
// sandbox by name or id; the server resolves it (id first, then name). Mode
// is "scrub_and_delete" or "full".
type CreateSandboxSnapshotRequest struct {
	SandboxRef  string `json:"sandbox_ref"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Mode        string `json:"mode,omitempty"`
}

// ListSandboxSnapshots lists sandbox-captured snapshots for the caller's org.
// repositoryID and sourceSandboxID are optional id filters; pass "" to omit.
func (c *Client) ListSandboxSnapshots(repositoryID, sourceSandboxID string) ([]SandboxSnapshot, error) {
	q := url.Values{}
	if repositoryID != "" {
		q.Set("repository_id", repositoryID)
	}
	if sourceSandboxID != "" {
		q.Set("source_sandbox_id", sourceSandboxID)
	}
	path := apiBasePath + "/sandbox-snapshots"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var envelope struct {
		Items []SandboxSnapshot `json:"items"`
	}
	if err := c.doJSON("GET", path, nil, &envelope); err != nil {
		return nil, fmt.Errorf("remote list sandbox snapshots: %w", err)
	}
	return envelope.Items, nil
}

// CreateSandboxSnapshot starts capturing a snapshot from a running sandbox.
// The endpoint returns 202 Accepted with the snapshot in the "capturing"
// state; poll with WaitForSandboxSnapshot (or ListSandboxSnapshots) until it
// reaches "active" or "failed".
func (c *Client) CreateSandboxSnapshot(req CreateSandboxSnapshotRequest) (*SandboxSnapshot, error) {
	var result SandboxSnapshot
	if err := c.doJSON("POST", apiBasePath+"/sandbox-snapshots", req, &result); err != nil {
		return nil, fmt.Errorf("remote create sandbox snapshot: %w", err)
	}
	return &result, nil
}

// GetSandboxSnapshot fetches a single sandbox snapshot by name or id. The
// server resolves it (id first, then name), matching DeleteSandboxSnapshot.
func (c *Client) GetSandboxSnapshot(ref string) (*SandboxSnapshot, error) {
	var result SandboxSnapshot
	if err := c.doJSON("GET", apiBasePath+"/sandbox-snapshots/"+url.PathEscape(ref)+"?by=ref", nil, &result); err != nil {
		return nil, fmt.Errorf("remote get sandbox snapshot: %w", err)
	}
	return &result, nil
}

// WaitForSandboxSnapshot polls GET /api/v0beta1/sandbox-snapshots/{ref} every
// pollInterval until the snapshot reaches a terminal state ("active" or
// "failed").
func (c *Client) WaitForSandboxSnapshot(ref string) (*SandboxSnapshot, error) {
	for {
		snap, err := c.GetSandboxSnapshot(ref)
		if err != nil {
			return nil, err
		}
		switch snap.State {
		case "active":
			return snap, nil
		case "failed":
			if snap.ErrorMessage != nil && *snap.ErrorMessage != "" {
				return snap, fmt.Errorf("%s", *snap.ErrorMessage)
			}
			return snap, fmt.Errorf("sandbox snapshot capture failed")
		}
		time.Sleep(pollInterval)
	}
}

// SandboxScrubPreview lists the injected secrets a "snapshot and delete" would
// remove from a sandbox (file paths + env var names only, no values).
type SandboxScrubPreview struct {
	Files   []string `json:"files"`
	EnvVars []string `json:"env_vars"`
}

// GetSandboxScrubPreview previews which injected secrets a scrub-and-delete
// snapshot would remove from the given sandbox. sandboxRef is a name or id;
// the server resolves it (id first, then name).
func (c *Client) GetSandboxScrubPreview(sandboxRef string) (*SandboxScrubPreview, error) {
	q := url.Values{}
	q.Set("sandbox", sandboxRef)
	q.Set("by", "ref")
	var result SandboxScrubPreview
	if err := c.doJSON("GET", apiBasePath+"/sandbox-snapshots/scrub-preview?"+q.Encode(), nil, &result); err != nil {
		return nil, fmt.Errorf("remote sandbox scrub preview: %w", err)
	}
	return &result, nil
}

// DeleteSandboxSnapshot deletes a sandbox snapshot referenced by name or id.
// The server resolves the reference (id first, then name).
func (c *Client) DeleteSandboxSnapshot(ref string) error {
	if err := c.doJSON("DELETE", apiBasePath+"/sandbox-snapshots/"+url.PathEscape(ref)+"?by=ref", nil, nil); err != nil {
		return fmt.Errorf("remote delete sandbox snapshot: %w", err)
	}
	return nil
}

// SandboxServiceResource is a live service on a running sandbox, as returned by
// the /api/v0beta1/sandbox-services endpoints. It unifies rows from the
// sandbox_services table with legacy jsonb entries; Source discriminates
// ("table" or "legacy"). Nullable fields are pointers because legacy entries
// and not-yet-provisioned services omit them.
type SandboxServiceResource struct {
	ID        *string `json:"id"`
	SandboxID string  `json:"sandbox_id"`
	Name      string  `json:"name"`
	Port      int     `json:"port"`
	URLScheme string  `json:"url_scheme"`
	Protocol  string  `json:"protocol"`
	URL       *string `json:"url"`
	HostPort  *int    `json:"host_port"`
	Source    string  `json:"source"`
	CreatedAt *string `json:"created_at"`
	UpdatedAt *string `json:"updated_at"`
}

// SandboxServiceRequest is the request body for creating or replacing a sandbox
// service (POST/PUT). url_scheme is "http" or "https".
type SandboxServiceRequest struct {
	Name      string `json:"name"`
	Port      int    `json:"port"`
	URLScheme string `json:"url_scheme"`
}

// ListSandboxServices lists live services for the caller's org. sandboxRef is
// an optional name-or-id filter forwarded as the sandbox_ref query param; pass
// "" to list all services in the org.
func (c *Client) ListSandboxServices(sandboxRef string) ([]SandboxServiceResource, error) {
	q := url.Values{}
	if sandboxRef != "" {
		q.Set("sandbox_ref", sandboxRef)
	}
	path := apiBasePath + "/sandbox-services"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var envelope struct {
		Items []SandboxServiceResource `json:"items"`
	}
	if err := c.doJSON("GET", path, nil, &envelope); err != nil {
		return nil, fmt.Errorf("remote list sandbox services: %w", err)
	}
	return envelope.Items, nil
}

// CreateSandboxService creates a service on the sandbox referenced by name or
// id. The server resolves sandboxRef (id first, then name) and returns the
// created SandboxServiceResource.
func (c *Client) CreateSandboxService(sandboxRef string, req SandboxServiceRequest) (*SandboxServiceResource, error) {
	path := apiBasePath + "/sandboxes/" + url.PathEscape(sandboxRef) + "/services"
	var result SandboxServiceResource
	if err := c.doJSON("POST", path, req, &result); err != nil {
		return nil, fmt.Errorf("remote create sandbox service: %w", err)
	}
	return &result, nil
}

// PutSandboxService fully replaces the service identified by serviceRef within
// the given sandbox. by selects how serviceRef is resolved ("name", "id", or
// "ref"); pass "" to default to "name". Returns the new SandboxServiceResource.
func (c *Client) PutSandboxService(sandboxRef, serviceRef, by string, req SandboxServiceRequest) (*SandboxServiceResource, error) {
	if by == "" {
		by = "name"
	}
	q := url.Values{}
	q.Set("by", by)
	path := apiBasePath + "/sandboxes/" + url.PathEscape(sandboxRef) + "/services/" + url.PathEscape(serviceRef) + "?" + q.Encode()
	var result SandboxServiceResource
	if err := c.doJSON("PUT", path, req, &result); err != nil {
		return nil, fmt.Errorf("remote put sandbox service: %w", err)
	}
	return &result, nil
}

// DeleteSandboxService deletes the service identified by serviceRef (resolved
// by name) within the given sandbox.
func (c *Client) DeleteSandboxService(sandboxRef, serviceRef string) error {
	path := apiBasePath + "/sandboxes/" + url.PathEscape(sandboxRef) + "/services/" + url.PathEscape(serviceRef) + "?by=name"
	if err := c.doJSON("DELETE", path, nil, nil); err != nil {
		return fmt.Errorf("remote delete sandbox service: %w", err)
	}
	return nil
}

// SecretSummary mirrors the API's SecretSummary schema, as returned by
// GET /api/v0beta1/secrets (array) and POST /api/v0beta1/secrets (single,
// 201). All fields are required by the schema (no omitempty); Description is
// nullable so it is a pointer.
type SecretSummary struct {
	ID          string  `json:"id"`
	OrgID       string  `json:"org_id"`
	UserID      string  `json:"user_id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Scope       string  `json:"scope"` // "user" or "org"
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
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
func (c *Client) ListSecrets() ([]SecretSummary, error) {
	var result []SecretSummary
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
	Type  string `json:"type"`            // "oauth" or "api_key" — required by the server
	Scope string `json:"scope,omitempty"` // "user" (default) or "org"; omitted means the server default
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
	ID    string `json:"id"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Scope string `json:"scope"` // "user" or "org"
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

// AgentSendResponse mirrors the API's AgentSendResponse schema, returned by
// POST /api/v0beta1/sandboxes/{id}/agent-send. SessionID, Response, IsError,
// and IsNewSession are required by the schema (no omitempty); AgentSessionID
// and CostUSD are optional.
type AgentSendResponse struct {
	SessionID      string   `json:"session_id"`
	Response       string   `json:"response"`
	IsError        bool     `json:"is_error"`
	IsNewSession   bool     `json:"is_new_session"`
	AgentSessionID string   `json:"agent_session_id,omitempty"`
	CostUSD        *float64 `json:"cost_usd,omitempty"`
}

// AgentSendJobResponse mirrors the API's AgentSendJobResponse schema,
// returned by the asynchronous agent-send-jobs endpoints
// (POST /api/v0beta1/sandboxes/{id}/agent-send-jobs and
// GET .../agent-send-jobs/{job_id}). AgentSessionID and ResultText are
// nullable (pointers); CostUSD is the only non-required field.
type AgentSendJobResponse struct {
	JobID          string   `json:"job_id"`
	State          string   `json:"state"`
	AgentSessionID *string  `json:"agent_session_id"`
	IsNewSession   bool     `json:"is_new_session"`
	IsError        bool     `json:"is_error"`
	ResultText     *string  `json:"result_text"`
	CostUSD        *float64 `json:"cost_usd,omitempty"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
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

// UploadFile is one requested file in a CreateUploadBatchRequest.
type UploadFile struct {
	// Filename is the object key within the org bucket. Relative paths only;
	// nested paths ("dir/report.json") are allowed.
	Filename string `json:"filename"`
	// Upsert overwrites an existing object at the same path when true. When
	// false (the default) uploading to an existing path fails.
	Upsert bool `json:"upsert,omitempty"`
}

// CreateUploadBatchRequest is the request body for POST
// /api/v0beta1/storage/uploads/batch. It requests one signed upload URL per
// file (1..100 files per call); the whole request fails if any file cannot be
// signed.
type CreateUploadBatchRequest struct {
	Files []UploadFile `json:"files"`
}

// UploadObject is one signed upload URL in an UploadBatchResponse, bound to a
// single object key.
type UploadObject struct {
	// Path is the sanitized object key the signed URL is bound to.
	Path string `json:"path"`
	// UploadURL is the absolute, single-use signed upload URL with the token
	// embedded in its query string. PUT the file bytes here.
	UploadURL string `json:"upload_url"`
	// Token is the signed upload JWT (also embedded in UploadURL), provided
	// separately for SDK clients that take a token argument.
	Token string `json:"token"`
}

// UploadBatchResponse is the response from POST /api/v0beta1/storage/uploads/batch.
// It carries one path-bound signed upload URL per requested file, in request
// order. The bytes for each are uploaded by a separate PUT to its UploadURL
// (see UploadToSignedURL); that PUT does not go through the Amika API.
type UploadBatchResponse struct {
	// Bucket is the org-scoped bucket name (derived server-side from the org id).
	Bucket string `json:"bucket"`
	// Objects holds one signed upload URL per requested file, in request order.
	Objects []UploadObject `json:"objects"`
	// ExpiresIn is the token lifetime in seconds.
	ExpiresIn int `json:"expires_in"`
}

// CreateUploadBatch requests one-time signed upload URLs for one or more objects
// in the caller's org-scoped storage bucket. Upload each file's bytes with
// UploadToSignedURL using the matching object's UploadURL.
func (c *Client) CreateUploadBatch(req CreateUploadBatchRequest) (*UploadBatchResponse, error) {
	var result UploadBatchResponse
	if err := c.doJSON("POST", apiBasePath+"/storage/uploads/batch", req, &result); err != nil {
		return nil, fmt.Errorf("remote create upload batch: %w", err)
	}
	return &result, nil
}

// UploadToSignedURL PUTs body to a signed upload URL returned by CreateUpload.
// The URL is absolute and carries its own token in the query string, so this
// bypasses BaseURL and sends no Authorization header. A non-2xx response is
// returned as a *HTTPError.
func (c *Client) UploadToSignedURL(signedURL string, body []byte, contentType string) error {
	req, err := http.NewRequest("PUT", signedURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("upload request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return &HTTPError{StatusCode: resp.StatusCode, Body: string(respBody)}
	}
	return nil
}

// DownloadObject is one object in a ListDownloadsResponse: its bucket key paired
// with a short-lived signed URL to fetch its bytes.
type DownloadObject struct {
	// Key is the object key within the bucket, preserving directory structure so
	// the tree can be recreated locally by writing each object to its key.
	Key string `json:"key"`
	// Size is the object size in bytes.
	Size int64 `json:"size"`
	// LastModified is the object's last-modified timestamp.
	LastModified string `json:"last_modified"`
	// DownloadURL is the absolute signed download URL; GET it to fetch the bytes.
	DownloadURL string `json:"download_url"`
}

// ListDownloadsResponse is one page of GET /api/v0beta1/storage/downloads: a
// flat, recursive, key-sorted listing of the org bucket, each object carrying
// its own signed download URL. Follow NextCursor for the next page.
type ListDownloadsResponse struct {
	// Bucket is the org-scoped bucket name (derived server-side from the org id).
	Bucket string `json:"bucket"`
	// Prefix is the subtree this listing was restricted to (empty = whole bucket).
	Prefix string `json:"prefix"`
	// Objects holds this page of objects, key-sorted.
	Objects []DownloadObject `json:"objects"`
	// ExpiresIn is the signed-URL lifetime in seconds.
	ExpiresIn int `json:"expires_in"`
	// NextCursor is the keyset cursor for the next page, or nil on the last page.
	NextCursor *string `json:"next_cursor"`
}

// ListDownloads fetches one page of the org bucket listing, each object paired
// with a signed download URL. prefix restricts the listing to a subtree (empty
// lists the whole bucket); cursor continues a prior page (empty starts at the
// beginning); limit caps the page size (<=0 lets the server choose). Retrieve
// each object's bytes with DownloadFromSignedURL.
func (c *Client) ListDownloads(prefix, cursor string, limit int) (*ListDownloadsResponse, error) {
	q := url.Values{}
	if prefix != "" {
		q.Set("prefix", prefix)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := apiBasePath + "/storage/downloads"
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var result ListDownloadsResponse
	if err := c.doJSON("GET", path, nil, &result); err != nil {
		return nil, fmt.Errorf("remote list downloads: %w", err)
	}
	return &result, nil
}

// DownloadFromSignedURL GETs the bytes from a signed download URL returned by
// CreateDownload. The URL is absolute and carries its own token in the query
// string, so this bypasses BaseURL and sends no Authorization header. A non-2xx
// response is returned as a *HTTPError.
func (c *Client) DownloadFromSignedURL(signedURL string) ([]byte, error) {
	req, err := http.NewRequest("GET", signedURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading download response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{StatusCode: resp.StatusCode, Body: string(body)}
	}
	return body, nil
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
