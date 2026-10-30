package apiclient

import (
	"encoding/json"
	"fmt"
	"strings"
)

// APIErrorResponse mirrors the JSON error envelope returned by the Amika
// API server (see api-error.ts). It carries a machine-readable error code
// and a human-readable message. Newer endpoints emit `code`; older ones emit
// `error_code`. Both are accepted.
type APIErrorResponse struct {
	Type      string `json:"type"`
	Code      string `json:"code"`
	ErrorCode string `json:"error_code"`
	Message   string `json:"message"`
}

// stableCode returns the machine-readable error code from either field.
func (r APIErrorResponse) stableCode() string {
	if r.Code != "" {
		return r.Code
	}
	return r.ErrorCode
}

// HTTPError is returned by doJSON when the server responds with a non-2xx
// status code. It carries the raw status and body so callers can inspect or
// parse the response for structured error information.
type HTTPError struct {
	StatusCode int
	Body       string
}

// UserMessage extracts the human-readable message from a structured API
// error response, prefixing the stable error code when present so users
// can self-serve. Falls back to the raw body if parsing fails.
func (e *HTTPError) UserMessage() string {
	var resp APIErrorResponse
	if json.Unmarshal([]byte(e.Body), &resp) == nil && resp.Message != "" {
		if code := resp.stableCode(); code != "" {
			return code + ": " + resp.Message
		}
		return resp.Message
	}
	if msg, ok := schemaRejectionMessage(e.Body); ok {
		return msg
	}
	return e.Body
}

// schemaRejectionMessage summarizes the body a route sends when its request
// schema rejects the body before any handler runs: Hono's zod validator
// replies {"success": false, "error": <ZodError>} rather than the API's
// error envelope. Zod 4 serializes the issues only as a JSON string in the
// error's `message`; zod 3 as an `issues` array. Either way this renders them
// the way the server's own envelope would ("Validation failed: model: ..."),
// so a mistyped enum value (`amika send --model`) names the field and the
// accepted values instead of printing escaped JSON. Reports false for any
// other shape, leaving the caller's raw-body fallback in place.
func schemaRejectionMessage(body string) (string, bool) {
	var raw struct {
		Success *bool `json:"success"`
		Error   struct {
			Message string           `json:"message"`
			Issues  []validatorIssue `json:"issues"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(body), &raw) != nil || raw.Success == nil || *raw.Success {
		return "", false
	}
	issues := raw.Error.Issues
	if len(issues) == 0 && json.Unmarshal([]byte(raw.Error.Message), &issues) != nil {
		return "", false
	}
	parts := make([]string, 0, len(issues))
	for _, issue := range issues {
		if issue.Message == "" {
			continue
		}
		if path := issue.pathString(); path != "" {
			parts = append(parts, path+": "+issue.Message)
		} else {
			parts = append(parts, issue.Message)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	return "Validation failed: " + strings.Join(parts, "; "), true
}

// validatorIssue is the part of one zod issue the summary needs. Path
// elements are object keys or array indexes, so they decode as `any`.
type validatorIssue struct {
	Path    []any  `json:"path"`
	Message string `json:"message"`
}

// pathString joins the issue's path with dots, as the server's envelope does.
func (i validatorIssue) pathString() string {
	parts := make([]string, len(i.Path))
	for n, p := range i.Path {
		parts[n] = fmt.Sprint(p)
	}
	return strings.Join(parts, ".")
}

// Code returns the stable machine-readable error code from a structured API
// error response, or "" when the body carries none.
func (e *HTTPError) Code() string {
	var resp APIErrorResponse
	if json.Unmarshal([]byte(e.Body), &resp) != nil {
		return ""
	}
	return resp.stableCode()
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.UserMessage())
}
