package apiclient

import (
	"encoding/json"
	"fmt"
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
	return e.Body
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.UserMessage())
}
