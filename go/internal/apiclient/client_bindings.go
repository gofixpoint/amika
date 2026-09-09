package apiclient

import (
	"fmt"
	"net/url"
)

// SandboxBinding mirrors the API's SandboxBinding schema. All fields are
// required by the schema so JSON output can round-trip the remote resource
// without dropping empty metadata or provenance.
type SandboxBinding struct {
	ID              string         `json:"id"`
	SandboxID       string         `json:"sandbox_id"`
	TargetNamespace string         `json:"target_namespace"`
	TargetKind      string         `json:"target_kind"`
	TargetID        string         `json:"target_id"`
	TargetURL       string         `json:"target_url"`
	Relationship    string         `json:"relationship"`
	Metadata        map[string]any `json:"metadata"`
	SystemMetadata  map[string]any `json:"system_metadata"`
	CreatedByKind   string         `json:"created_by_kind"`
	CreatedByID     string         `json:"created_by_id"`
	CreatedAt       string         `json:"created_at"`
	UpdatedAt       string         `json:"updated_at"`
}

// CreateSandboxBindingRequest is the body sent when binding a sandbox to an
// external target. TargetURL is deliberately carried in JSON rather than in a
// URL path segment.
type CreateSandboxBindingRequest struct {
	TargetURL string `json:"target_url"`
}

// CreateSandboxBindingResponse mirrors the API response returned after a
// binding is created or an existing identical binding is found.
type CreateSandboxBindingResponse struct {
	ID string `json:"id"`
}

// ListSandboxBindingsResponse mirrors the API's binding-list envelope. Items
// is always present and callers should normalize a missing JSON value to an
// empty slice before re-encoding it.
type ListSandboxBindingsResponse struct {
	Items []SandboxBinding `json:"items"`
}

// CreateSandboxBinding binds a sandbox, resolved by name or ID, to targetURL.
func (c *Client) CreateSandboxBinding(sandboxRef, targetURL string) (*CreateSandboxBindingResponse, error) {
	path := apiBasePath + "/sandboxes/" + url.PathEscape(sandboxRef) + "/bindings?sandbox_by=ref"
	var result CreateSandboxBindingResponse
	if err := c.doJSON("POST", path, CreateSandboxBindingRequest{TargetURL: targetURL}, &result); err != nil {
		return nil, fmt.Errorf("remote create sandbox binding: %w", err)
	}
	return &result, nil
}

// ListSandboxBindings lists all sandbox bindings in the caller's organization.
func (c *Client) ListSandboxBindings() (*ListSandboxBindingsResponse, error) {
	var result ListSandboxBindingsResponse
	if err := c.doJSON("GET", apiBasePath+"/sandbox-bindings", nil, &result); err != nil {
		return nil, fmt.Errorf("remote list sandbox bindings: %w", err)
	}
	if result.Items == nil {
		result.Items = []SandboxBinding{}
	}
	return &result, nil
}

// ListBindingsForSandbox lists bindings for a sandbox resolved by name or ID.
func (c *Client) ListBindingsForSandbox(sandboxRef string) (*ListSandboxBindingsResponse, error) {
	path := apiBasePath + "/sandboxes/" + url.PathEscape(sandboxRef) + "/bindings?sandbox_by=ref"
	var result ListSandboxBindingsResponse
	if err := c.doJSON("GET", path, nil, &result); err != nil {
		return nil, fmt.Errorf("remote list bindings for sandbox: %w", err)
	}
	if result.Items == nil {
		result.Items = []SandboxBinding{}
	}
	return &result, nil
}

// DeleteSandboxBinding deletes a sandbox binding by its opaque binding ID.
func (c *Client) DeleteSandboxBinding(bindingID string) error {
	path := apiBasePath + "/sandbox-bindings/" + url.PathEscape(bindingID)
	if err := c.doJSON("DELETE", path, nil, nil); err != nil {
		return fmt.Errorf("remote delete sandbox binding: %w", err)
	}
	return nil
}
