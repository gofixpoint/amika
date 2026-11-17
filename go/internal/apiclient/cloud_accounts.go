package apiclient

// cloud_accounts.go calls the cloud accounts API, /cloud-accounts
// (amika-mono's specs/030-cloud-accounts.md). A cloud account is an
// organization's own account at a sandbox provider (bring your own cloud),
// which rigs can run in instead of Amika Cloud. Its API key goes up on create
// and update and never comes back.

import "net/url"

// CloudAccountNameAmika is the account name that always means Amika Cloud,
// on every provider. No connected account can take it.
const CloudAccountNameAmika = "amika"

// CloudAccountSelector names one cloud account: Value is matched against the
// field By names (SelectByRef, SelectByName, or SelectByID; empty means
// SelectByRef). Names are unique per provider, not per organization, so a
// non-empty Provider narrows the match to that provider's accounts.
type CloudAccountSelector struct {
	Value    string
	By       string
	Provider string
}

// kind returns the selector's kind with the empty default spelled out.
func (s CloudAccountSelector) kind() string {
	if s.By == "" {
		return SelectByRef
	}
	return s.By
}

// path builds /cloud-accounts/{ref}. `by` defaults to ref there, so a ref
// selector leaves it off the wire.
func (s CloudAccountSelector) path() string {
	path := apiBasePath + "/cloud-accounts/" + url.PathEscape(s.Value)
	q := url.Values{}
	if k := s.kind(); k != SelectByRef {
		q.Set("by", k)
	}
	if s.Provider != "" {
		q.Set("provider", s.Provider)
	}
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return path
}

// CloudAccount mirrors the API's CloudAccount schema. The account's API key
// is never part of it.
type CloudAccount struct {
	// ID is the account's "cacc_<uuid>" identifier.
	ID string `json:"id"`
	// Provider is the sandbox provider the account is at, e.g. "e2b",
	// "daytona", or "instabox".
	Provider string `json:"provider"`
	// Name is unique per provider in the organization.
	Name string `json:"name"`
	// IsDefault marks the account a rig create lands in when it names the
	// provider and no account. A provider has at most one default.
	IsDefault bool   `json:"is_default"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// ListCloudAccountsResponse mirrors the API's ListCloudAccountsResponse
// schema.
type ListCloudAccountsResponse struct {
	Items []CloudAccount `json:"items"`
}

// CreateCloudAccountRequest is the request body for
// POST /api/v0beta1/cloud-accounts. A nil IsDefault is omitted, and the
// server creates the account as not the default.
type CreateCloudAccountRequest struct {
	Provider  string `json:"provider"`
	Name      string `json:"name"`
	APIKey    string `json:"api_key"`
	IsDefault *bool  `json:"is_default,omitempty"`
}

// UpdateCloudAccountRequest is the request body for
// PATCH /api/v0beta1/cloud-accounts/{ref}. A nil field is omitted and keeps
// its value.
type UpdateCloudAccountRequest struct {
	Name      *string `json:"name,omitempty"`
	APIKey    *string `json:"api_key,omitempty"`
	IsDefault *bool   `json:"is_default,omitempty"`
}

// ListCloudAccounts calls GET /api/v0beta1/cloud-accounts. A non-empty
// provider lists only that provider's accounts.
func (c *Client) ListCloudAccounts(provider string) (*ListCloudAccountsResponse, error) {
	path := apiBasePath + "/cloud-accounts"
	if provider != "" {
		path += "?" + url.Values{"provider": {provider}}.Encode()
	}
	var out ListCloudAccountsResponse
	if err := c.doJSON("GET", path, nil, &out); err != nil {
		return nil, err
	}
	if out.Items == nil {
		out.Items = []CloudAccount{}
	}
	return &out, nil
}

// CreateCloudAccount calls POST /api/v0beta1/cloud-accounts. The server
// refuses with 409 cloud_account_exists while the provider already has an
// account, and cloud_account_name_taken when the name is in use there.
func (c *Client) CreateCloudAccount(req CreateCloudAccountRequest) (*CloudAccount, error) {
	var out CloudAccount
	if err := c.doJSON("POST", apiBasePath+"/cloud-accounts", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetCloudAccount calls GET /api/v0beta1/cloud-accounts/{ref}.
func (c *Client) GetCloudAccount(sel CloudAccountSelector) (*CloudAccount, error) {
	var out CloudAccount
	if err := c.doJSON("GET", sel.path(), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateCloudAccount calls PATCH /api/v0beta1/cloud-accounts/{ref}.
func (c *Client) UpdateCloudAccount(sel CloudAccountSelector, req UpdateCloudAccountRequest) (*CloudAccount, error) {
	var out CloudAccount
	if err := c.doJSON("PATCH", sel.path(), req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteCloudAccount calls DELETE /api/v0beta1/cloud-accounts/{ref}. The
// server refuses with 409 cloud_account_in_use while rigs or snapshots
// remain in the account.
func (c *Client) DeleteCloudAccount(sel CloudAccountSelector) error {
	return c.doJSON("DELETE", sel.path(), nil, nil)
}
