package apiclient

import (
	"errors"
	"net/url"
)

// Sandbox selector kinds: which field of a sandbox a SandboxSelector's Value
// is matched against. They are the API's `by`/`sandbox_by` values.
const (
	// SelectByRef matches by id or by name. The server refuses a value that is
	// one sandbox's id and another sandbox's name with a 409
	// resource_ref_ambiguous. It is the server's default.
	SelectByRef = "ref"
	// SelectByName matches by name only.
	SelectByName = "name"
	// SelectByID matches by id only.
	SelectByID = "id"
)

// SandboxSelector names one existing sandbox in a request: Value is matched
// against the field By names (SelectByRef, SelectByName, or SelectByID; empty
// means SelectByRef).
//
// On the routes under /sandboxes/{ref}, a SelectByRef selector puts nothing but
// Value on the wire, since ref is the server's default there; a name or id
// selector adds the `by`/`sandbox_by` parameter. Requests that name a sandbox
// in the body or a list filter use the field the kind calls for
// (sandbox_ref, sandbox_name, or sandbox_id).
type SandboxSelector struct {
	Value string
	By    string
}

// SandboxByRef selects the sandbox whose id or name is value.
func SandboxByRef(value string) SandboxSelector {
	return SandboxSelector{Value: value, By: SelectByRef}
}

// SandboxByID selects the sandbox whose id is value. Use it for an id the API
// itself returned: a ref could also match another sandbox named after that id
// and draw a 409.
func SandboxByID(value string) SandboxSelector {
	return SandboxSelector{Value: value, By: SelectByID}
}

// kind returns the selector's kind with the empty default spelled out.
func (s SandboxSelector) kind() string {
	if s.By == "" {
		return SelectByRef
	}
	return s.By
}

// pinned returns the selector's kind when it pins one field, and "" for a ref
// match, which the server applies by default and so is left off the wire.
func (s SandboxSelector) pinned() string {
	if k := s.kind(); k != SelectByRef {
		return k
	}
	return ""
}

// sandboxPath builds the path of a route under /sandboxes/{ref}: suffix is
// appended after the escaped reference, and param names the query parameter
// that carries a pinned selector ("by" when the sandbox is the resource,
// "sandbox_by" when it is the parent of one). q holds any other query
// parameters and may be nil.
func sandboxPath(s SandboxSelector, param, suffix string, q url.Values) string {
	path := apiBasePath + "/sandboxes/" + url.PathEscape(s.Value) + suffix
	if by := s.pinned(); by != "" {
		if q == nil {
			q = url.Values{}
		}
		q.Set(param, by)
	}
	if encoded := q.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return path
}

// ErrCodeResourceRefAmbiguous is the API error code for a ref-kind selector
// whose value is one resource's id and another resource's name.
const ErrCodeResourceRefAmbiguous = "resource_ref_ambiguous"

// IsResourceRefAmbiguous reports whether err carries the API's 409
// resource_ref_ambiguous error.
func IsResourceRefAmbiguous(err error) bool {
	var httpErr *HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == 409 && httpErr.Code() == ErrCodeResourceRefAmbiguous
}
