package apiclient

import "fmt"

// API key scopes accepted by POST /api/v0beta1/api-keys.
const (
	// APIKeyScopeOrganization mints a key owned by the caller's organization.
	// It is the server's default when a create request names no scope.
	APIKeyScopeOrganization = "organization"
	// APIKeyScopeUser mints a key owned by the calling user. A caller that is
	// itself an organization-scoped API key has no user, and the API refuses
	// it with 400.
	APIKeyScopeUser = "user"
)

// CreateAPIKeyRequest is the request body for POST /api/v0beta1/api-keys. An
// empty Scope is omitted, so the server applies its default (organization).
type CreateAPIKeyRequest struct {
	Name  string `json:"name"`
	Scope string `json:"scope,omitempty"`
}

// APIKey mirrors the API's ApiKeySummary schema: everything about a key
// except its value. Its fields keep the API's camelCase spelling, since it is
// the type the CLI re-encodes for `-o json` and a renamed field would decode
// as its zero value with no error.
type APIKey struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Scope           string  `json:"scope"`
	ObfuscatedValue string  `json:"obfuscatedValue"`
	LastUsedAt      *string `json:"lastUsedAt"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

// CreatedAPIKey mirrors the API's ApiKeyWithValue schema, the 201 response
// of POST /api/v0beta1/api-keys: the key's summary plus its plaintext value,
// which the API returns this once and never again.
type CreatedAPIKey struct {
	APIKey
	Value APIKeyValue `json:"value"`
}

// APIKeyValue is a plaintext API key. It formats as "[redacted]" with fmt's
// %s, %v, %q and %#v, so a stray log line or error message that includes it
// cannot leak the key; Reveal returns the real value for the one place that
// must write it.
type APIKeyValue string

const redacted = "[redacted]"

// Reveal returns the plaintext key.
func (v APIKeyValue) Reveal() string { return string(v) }

// String implements fmt.Stringer, redacting the key.
func (v APIKeyValue) String() string { return redacted }

// GoString implements fmt.GoStringer, redacting the key.
func (v APIKeyValue) GoString() string { return redacted }

// CreateAPIKey mints an API key through POST /api/v0beta1/api-keys. The
// returned value is the only copy of the plaintext key there will ever be.
func (c *Client) CreateAPIKey(req CreateAPIKeyRequest) (*CreatedAPIKey, error) {
	var result CreatedAPIKey
	if err := c.doJSON("POST", apiBasePath+"/api-keys", req, &result); err != nil {
		return nil, fmt.Errorf("remote create API key: %w", err)
	}
	// A 2xx without a key (a proxy's empty answer, or a redirect that turned
	// the POST into a GET of the key listing) is not a created key.
	if result.ID == "" || result.Value == "" {
		return nil, fmt.Errorf("remote create API key: response holds no key")
	}
	return &result, nil
}
