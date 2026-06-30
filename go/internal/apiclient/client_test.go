package apiclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestPathEscapesSandboxName(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantPath   string
	}{
		{
			name:       "GetSandbox with slash",
			call:       func(c *Client) error { _, err := c.GetSandbox("org/proj"); return err },
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/sandboxes/org%2Fproj",
		},
		{
			name:       "DeleteSandbox with slash",
			call:       func(c *Client) error { return c.DeleteSandbox("org/proj") },
			wantMethod: "DELETE",
			wantPath:   "/api/v0beta1/sandboxes/org%2Fproj",
		},
		{
			name:       "StartSandbox with slash",
			call:       func(c *Client) error { return c.StartSandbox("a/b") },
			wantMethod: "POST",
			wantPath:   "/api/v0beta1/sandboxes/a%2Fb/start",
		},
		{
			name:       "StopSandbox with slash",
			call:       func(c *Client) error { return c.StopSandbox("a/b") },
			wantMethod: "POST",
			wantPath:   "/api/v0beta1/sandboxes/a%2Fb/stop",
		},
		{
			name:       "GetSSH with slash",
			call:       func(c *Client) error { _, err := c.GetSSH("a/b"); return err },
			wantMethod: "POST",
			wantPath:   "/api/v0beta1/sandboxes/a%2Fb/ssh",
		},
		{
			name:       "RevokeSSH with slash",
			call:       func(c *Client) error { return c.RevokeSSH("a/b", "tok") },
			wantMethod: "DELETE",
			wantPath:   "/api/v0beta1/sandboxes/a%2Fb/ssh",
		},
		{
			name:       "ListSessions with slash",
			call:       func(c *Client) error { _, err := c.ListSessions("a/b"); return err },
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/sandboxes/a%2Fb/sessions",
		},
		{
			name: "AgentSend with slash",
			call: func(c *Client) error {
				_, err := c.AgentSend("a/b", AgentSendRequest{Message: "hi"})
				return err
			},
			wantMethod: "POST",
			wantPath:   "/api/v0beta1/sandboxes/a%2Fb/agent-send",
		},
		{
			name:       "GetSandbox without slash",
			call:       func(c *Client) error { _, err := c.GetSandbox("simple-name"); return err },
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/sandboxes/simple-name",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.RequestURI
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(map[string]string{"id": "1", "name": "test", "state": "active"})
			}))
			defer srv.Close()

			c := NewClient(srv.URL, "test-token")
			_ = tt.call(c)

			if gotMethod != tt.wantMethod {
				t.Errorf("method = %q, want %q", gotMethod, tt.wantMethod)
			}
			if gotPath != tt.wantPath {
				t.Errorf("path = %q, want %q", gotPath, tt.wantPath)
			}
		})
	}
}

func TestGetSSHParsesResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"ssh_destination": "user-token@ssh.app.daytona.io",
			"token":           "tok-123",
			"expires_at":      "2026-06-04T18:30:00.000Z",
			"sandbox_id":      "sb_01HXYZ",
			"sandbox_name":    "my-sandbox",
			"repo_name":       "my-repo",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	info, err := c.GetSSH("my-sandbox")
	if err != nil {
		t.Fatalf("GetSSH: %v", err)
	}
	if info.SandboxID != "sb_01HXYZ" {
		t.Errorf("SandboxID = %q, want %q", info.SandboxID, "sb_01HXYZ")
	}
	if info.SandboxName != "my-sandbox" {
		t.Errorf("SandboxName = %q, want %q", info.SandboxName, "my-sandbox")
	}
	if info.SSHDestination != "user-token@ssh.app.daytona.io" {
		t.Errorf("SSHDestination = %q", info.SSHDestination)
	}
}

func TestExtractAgentAuthError(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		wantHit bool
	}{
		{
			name:    "non-HTTPError is ignored",
			err:     fmt.Errorf("some other error"),
			wantHit: false,
		},
		{
			name:    "HTTPError without JSON body",
			err:     &HTTPError{StatusCode: 500, Body: "internal server error"},
			wantHit: false,
		},
		{
			name: "HTTPError with auth failure in agent result",
			err: &HTTPError{StatusCode: 500, Body: mustJSON(t, map[string]interface{}{
				"error": "Agent command failed",
				"details": mustJSONString(t, map[string]interface{}{
					"type":     "result",
					"is_error": true,
					"result":   `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}`,
				}),
			})},
			wantHit: true,
		},
		{
			name: "HTTPError with non-auth agent error",
			err: &HTTPError{StatusCode: 500, Body: mustJSON(t, map[string]interface{}{
				"error": "Agent command failed",
				"details": mustJSONString(t, map[string]interface{}{
					"type":     "result",
					"is_error": true,
					"result":   "Some other agent error",
				}),
			})},
			wantHit: false,
		},
		{
			name: "HTTPError with is_error false",
			err: &HTTPError{StatusCode: 500, Body: mustJSON(t, map[string]interface{}{
				"error": "Agent command failed",
				"details": mustJSONString(t, map[string]interface{}{
					"type":     "result",
					"is_error": false,
					"result":   "Failed to authenticate. API Error: 401",
				}),
			})},
			wantHit: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractAgentAuthError(tt.err)
			if tt.wantHit && got == "" {
				t.Error("expected auth error to be detected, got empty string")
			}
			if !tt.wantHit && got != "" {
				t.Errorf("expected no auth error, got %q", got)
			}
		})
	}
}

func TestAgentSendAuthErrorMessage(t *testing.T) {
	details := mustJSONString(t, map[string]interface{}{
		"type":     "result",
		"is_error": true,
		"result":   `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}`,
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error":   "Agent command failed",
			"details": details,
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "test-token")
	_, err := c.AgentSend("test-sandbox", AgentSendRequest{Message: "hello"})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	msg := err.Error()
	if !strings.Contains(msg, "failed to authenticate with its AI provider") {
		t.Errorf("error should mention auth provider failure, got: %s", msg)
	}
	if !strings.Contains(msg, "expired or been revoked") { //nolint:dupword
		t.Errorf("error should mention expired credentials, got: %s", msg)
	}
}

func mustJSON(t *testing.T, v interface{}) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("mustJSON: %v", err)
	}
	return string(b)
}

func mustJSONString(t *testing.T, v interface{}) string {
	t.Helper()
	return mustJSON(t, v)
}

func TestCreateUploadBatch_SendsFilesAndAuth(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	var gotBody CreateUploadBatchRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"bucket": "org-123",
			"objects": []map[string]any{{
				"path":       "amika/claude/x.json",
				"upload_url": "https://store.example/upload/sign/org-123/amika/claude/x.json?token=abc",
				"token":      "abc",
			}},
			"expires_in": 7200,
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key-xyz")
	resp, err := c.CreateUploadBatch(CreateUploadBatchRequest{Files: []UploadFile{{Filename: "amika/claude/x.json"}}})
	if err != nil {
		t.Fatalf("CreateUploadBatch: %v", err)
	}
	if gotMethod != "POST" {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/v0beta1/storage/uploads/batch" {
		t.Errorf("path = %q, want /api/v0beta1/storage/uploads/batch", gotPath)
	}
	if gotAuth != "Bearer key-xyz" {
		t.Errorf("auth = %q, want Bearer key-xyz", gotAuth)
	}
	if len(gotBody.Files) != 1 || gotBody.Files[0].Filename != "amika/claude/x.json" {
		t.Errorf("files = %+v", gotBody.Files)
	}
	if len(resp.Objects) != 1 || resp.Objects[0].UploadURL == "" || resp.Objects[0].Token != "abc" || resp.ExpiresIn != 7200 {
		t.Errorf("response = %+v", resp)
	}
}

func TestUploadToSignedURL_PutsBytesWithoutAuth(t *testing.T) {
	var gotMethod, gotAuth, gotType string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		gotType = r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewClient("https://api.example", "key-xyz")
	if err := c.UploadToSignedURL(srv.URL+"/upload?token=abc", []byte(`{"x":1}`), "application/json"); err != nil {
		t.Fatalf("UploadToSignedURL: %v", err)
	}
	if gotMethod != "PUT" {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotAuth != "" {
		t.Errorf("auth header = %q, want empty (token is in the URL)", gotAuth)
	}
	if gotType != "application/json" {
		t.Errorf("content-type = %q", gotType)
	}
	if string(gotBody) != `{"x":1}` {
		t.Errorf("body = %q", string(gotBody))
	}
}

func TestUploadToSignedURL_Non2xxIsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("denied"))
	}))
	defer srv.Close()

	c := NewClient("https://api.example", "key-xyz")
	err := c.UploadToSignedURL(srv.URL, []byte("x"), "application/json")
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("error = %v, want *HTTPError", err)
	}
	if httpErr.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", httpErr.StatusCode)
	}
}

func TestListDownloads_SendsQueryAndParsesPage(t *testing.T) {
	var gotMethod, gotPath, gotRawQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotRawQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"bucket": "org-123",
			"prefix": "",
			"objects": []map[string]any{{
				"key":           "amika/claude/x.json",
				"size":          12,
				"last_modified": "2026-01-01T00:00:00Z",
				"download_url":  "https://store.example/object/sign/org-123/amika/claude/x.json?token=abc",
			}},
			"expires_in":  3600,
			"next_cursor": "CURSOR2",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key-xyz")
	resp, err := c.ListDownloads("", "", 1000)
	if err != nil {
		t.Fatalf("ListDownloads: %v", err)
	}
	if gotMethod != "GET" {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if gotPath != "/api/v0beta1/storage/downloads" {
		t.Errorf("path = %q, want /api/v0beta1/storage/downloads", gotPath)
	}
	if gotRawQuery != "limit=1000" {
		t.Errorf("query = %q, want limit=1000", gotRawQuery)
	}
	if gotAuth != "Bearer key-xyz" {
		t.Errorf("auth = %q, want Bearer key-xyz", gotAuth)
	}
	if len(resp.Objects) != 1 || resp.Objects[0].Key != "amika/claude/x.json" || resp.Objects[0].DownloadURL == "" {
		t.Errorf("objects = %+v", resp.Objects)
	}
	if resp.Objects[0].Size != 12 {
		t.Errorf("size = %d, want 12", resp.Objects[0].Size)
	}
	if resp.NextCursor == nil || *resp.NextCursor != "CURSOR2" {
		t.Errorf("next_cursor = %v, want CURSOR2", resp.NextCursor)
	}
}

func TestListDownloads_PassesPrefixAndCursorOmitsZeroLimit(t *testing.T) {
	var gotRawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"bucket":      "org-123",
			"prefix":      "amika/",
			"objects":     []any{},
			"expires_in":  3600,
			"next_cursor": nil,
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "key-xyz")
	resp, err := c.ListDownloads("amika/", "CUR", 0)
	if err != nil {
		t.Fatalf("ListDownloads: %v", err)
	}
	q, err := url.ParseQuery(gotRawQuery)
	if err != nil {
		t.Fatalf("parsing query %q: %v", gotRawQuery, err)
	}
	if q.Get("prefix") != "amika/" {
		t.Errorf("prefix = %q, want amika/", q.Get("prefix"))
	}
	if q.Get("cursor") != "CUR" {
		t.Errorf("cursor = %q, want CUR", q.Get("cursor"))
	}
	if _, ok := q["limit"]; ok {
		t.Errorf("limit present in query %q, want omitted when <=0", gotRawQuery)
	}
	if resp.NextCursor != nil {
		t.Errorf("next_cursor = %v, want nil", resp.NextCursor)
	}
}

func TestDownloadFromSignedURL_GetsBytesWithoutAuth(t *testing.T) {
	var gotMethod, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"event":1}`))
	}))
	defer srv.Close()

	c := NewClient("https://api.example", "key-xyz")
	body, err := c.DownloadFromSignedURL(srv.URL + "/object?token=abc")
	if err != nil {
		t.Fatalf("DownloadFromSignedURL: %v", err)
	}
	if gotMethod != "GET" {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if gotAuth != "" {
		t.Errorf("auth header = %q, want empty (token is in the URL)", gotAuth)
	}
	if string(body) != `{"event":1}` {
		t.Errorf("body = %q", string(body))
	}
}

func TestDownloadFromSignedURL_Non2xxIsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("missing"))
	}))
	defer srv.Close()

	c := NewClient("https://api.example", "key-xyz")
	_, err := c.DownloadFromSignedURL(srv.URL)
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) {
		t.Fatalf("error = %v, want *HTTPError", err)
	}
	if httpErr.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", httpErr.StatusCode)
	}
}

// folderPrefixBucket is an httptest server that mimics the storage backend's
// listing semantics: it treats the `prefix` query as a FOLDER path, so it
// returns an object only when the prefix is empty or ends in "/". A prefix equal
// to a full object key (filename included, no trailing slash) matches nothing —
// the exact behavior that made GetObjectByKey re-upload every memory file when
// it listed by the full key. Each object's download_url points back at this same
// server so the returned bytes can be fetched.
func folderPrefixBucket(t *testing.T, objects map[string]string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v0beta1/storage/downloads":
			prefix := r.URL.Query().Get("prefix")
			out := []map[string]any{}
			for key := range objects {
				// Folder semantics: only an empty or "/"-terminated prefix lists
				// objects; a full-key prefix matches nothing.
				if prefix != "" && !strings.HasSuffix(prefix, "/") {
					continue
				}
				if !strings.HasPrefix(key, prefix) {
					continue
				}
				out = append(out, map[string]any{
					"key":           key,
					"size":          len(objects[key]),
					"last_modified": "2026-01-01T00:00:00Z",
					"download_url":  srv.URL + "/dl?key=" + url.QueryEscape(key),
				})
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]any{
				"bucket":      "org-123",
				"prefix":      prefix,
				"objects":     out,
				"expires_in":  3600,
				"next_cursor": nil,
			})
		case "/dl":
			body, ok := objects[r.URL.Query().Get("key")]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(body))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestGetObjectByKey_FindsObjectViaFolderPrefix is the regression test for the
// memory re-upload bug: against a backend that only honors folder prefixes,
// GetObjectByKey must still find an object by listing its parent folder and
// exact-matching the key, rather than listing by the full key (which returns
// nothing). It also asserts the prefix actually sent is the folder, not the key.
func TestGetObjectByKey_FindsObjectViaFolderPrefix(t *testing.T) {
	objects := map[string]string{
		"decyph-ai-app/memory/memory.md": `{"a":1}`,
		// A sibling that shares the folder, to ensure exact-match (not just
		// prefix-match) selects the right object.
		"decyph-ai-app/memory/memory.md.bak": `{"a":2}`,
	}
	srv := folderPrefixBucket(t, objects)

	var gotPrefix string
	c := NewClient(srv.URL, "key-xyz")
	c.HTTP = recordPrefixClient(&gotPrefix)

	data, found, err := c.GetObjectByKey("decyph-ai-app/memory/memory.md")
	if err != nil {
		t.Fatalf("GetObjectByKey: %v", err)
	}
	if !found {
		t.Fatal("found = false, want true (object exists under the folder)")
	}
	if string(data) != `{"a":1}` {
		t.Errorf("data = %q, want %q", string(data), `{"a":1}`)
	}
	if gotPrefix != "decyph-ai-app/memory/" {
		t.Errorf("listing prefix = %q, want the parent folder %q", gotPrefix, "decyph-ai-app/memory/")
	}
}

// TestGetObjectByKey_NotFound confirms a genuinely absent object reports found
// = false (so callers treat it as "no cloud copy yet"), even though the folder
// listing returns sibling objects.
func TestGetObjectByKey_NotFound(t *testing.T) {
	srv := folderPrefixBucket(t, map[string]string{
		"decyph-ai-app/memory/memory.md": `{"a":1}`,
	})
	c := NewClient(srv.URL, "key-xyz")

	data, found, err := c.GetObjectByKey("decyph-ai-app/memory/absent.md")
	if err != nil {
		t.Fatalf("GetObjectByKey: %v", err)
	}
	if found {
		t.Errorf("found = true, want false for an absent key (data %q)", string(data))
	}
}

// recordPrefixClient returns an *http.Client whose transport records the latest
// `prefix` query parameter seen on a downloads listing request before forwarding
// it unchanged, letting a test assert which prefix GetObjectByKey listed by.
func recordPrefixClient(prefix *string) *http.Client {
	return &http.Client{Transport: prefixRecorder{prefix: prefix}}
}

type prefixRecorder struct{ prefix *string }

func (p prefixRecorder) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == "/api/v0beta1/storage/downloads" {
		*p.prefix = r.URL.Query().Get("prefix")
	}
	return http.DefaultTransport.RoundTrip(r)
}
