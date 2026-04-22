package apiclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// APIErrorResponse mirrors the JSON error envelope returned by the Amika
// API server (see api-error.ts). It carries a machine-readable error code
// and a human-readable message.
type APIErrorResponse struct {
	Type      string `json:"type"`
	ErrorCode string `json:"error_code"`
	Message   string `json:"message"`
}

// HTTPError is returned by doJSON when the server responds with a non-2xx
// status code. It carries the raw status and body so callers can inspect or
// parse the response for structured error information.
type HTTPError struct {
	StatusCode int
	Body       string
}

// UserMessage extracts the human-readable message from a structured API
// error response. Falls back to the raw body if parsing fails.
func (e *HTTPError) UserMessage() string {
	var resp APIErrorResponse
	if json.Unmarshal([]byte(e.Body), &resp) == nil && resp.Message != "" {
		return resp.Message
	}
	return e.Body
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.UserMessage())
}

// extractAgentAuthError inspects an error returned by the agent-send endpoint
// and returns a short description if the root cause is an authentication
// failure in the agent's AI provider (e.g. Anthropic 401). Returns "" if the
// error is not auth-related.
func extractAgentAuthError(err error) string {
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		return ""
	}

	// The server wraps the agent result as {"error":"...","details":"<json>"}.
	var envelope struct {
		Error   string `json:"error"`
		Details string `json:"details"`
	}
	if json.Unmarshal([]byte(httpErr.Body), &envelope) != nil || envelope.Details == "" {
		return ""
	}

	// The details string is itself JSON with the agent run result.
	var agentResult struct {
		IsError bool   `json:"is_error"`
		Result  string `json:"result"`
	}
	if json.Unmarshal([]byte(envelope.Details), &agentResult) != nil {
		return ""
	}

	if !agentResult.IsError {
		return ""
	}

	r := agentResult.Result
	if strings.Contains(r, "authentication_error") || strings.Contains(r, "Invalid authentication credentials") || strings.Contains(r, "Failed to authenticate") {
		return r
	}
	return ""
}
