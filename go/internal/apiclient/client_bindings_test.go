package apiclient

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestSandboxBindingRequestShapes(t *testing.T) {
	const targetURL = "https://github.com/gofixpoint/amika/pull/23?view=files#discussion"
	tests := []struct {
		name       string
		call       func(*Client) error
		wantMethod string
		wantURI    string
		wantBody   string
	}{
		{
			name: "create escapes sandbox ref and carries target in body",
			call: func(client *Client) error {
				_, err := client.CreateSandboxBinding("team/runner box", targetURL)
				return err
			},
			wantMethod: http.MethodPost,
			wantURI:    "/api/v0beta1/sandboxes/team%2Frunner%20box/bindings?sandbox_by=ref",
			wantBody:   `{"target_url":"` + targetURL + `"}`,
		},
		{
			name: "list organization bindings",
			call: func(client *Client) error {
				_, err := client.ListSandboxBindings()
				return err
			},
			wantMethod: http.MethodGet,
			wantURI:    "/api/v0beta1/sandbox-bindings",
		},
		{
			name: "list sandbox bindings by ref",
			call: func(client *Client) error {
				_, err := client.ListBindingsForSandbox("team/runner box")
				return err
			},
			wantMethod: http.MethodGet,
			wantURI:    "/api/v0beta1/sandboxes/team%2Frunner%20box/bindings?sandbox_by=ref",
		},
		{
			name:       "delete escapes binding ID",
			call:       func(client *Client) error { return client.DeleteSandboxBinding("sbind/team one") },
			wantMethod: http.MethodDelete,
			wantURI:    "/api/v0beta1/sandbox-bindings/sbind%2Fteam%20one",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotURI, gotBody string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				gotMethod = request.Method
				gotURI = request.RequestURI
				body, err := io.ReadAll(request.Body)
				if err != nil {
					t.Errorf("read request body: %v", err)
				}
				gotBody = string(body)
				if request.Method == http.MethodDelete {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if request.Method == http.MethodPost {
					_, _ = io.WriteString(w, `{"id":"sbind_1"}`)
					return
				}
				_, _ = io.WriteString(w, `{"items":[]}`)
			}))
			defer server.Close()

			if err := tt.call(NewClient(server.URL, "test-token")); err != nil {
				t.Fatalf("call: %v", err)
			}
			if gotMethod != tt.wantMethod {
				t.Errorf("method = %q, want %q", gotMethod, tt.wantMethod)
			}
			if gotURI != tt.wantURI {
				t.Errorf("request URI = %q, want %q", gotURI, tt.wantURI)
			}
			if gotBody != tt.wantBody {
				t.Errorf("body = %q, want %q", gotBody, tt.wantBody)
			}
			if strings.Contains(gotURI, "github.com") {
				t.Errorf("raw target URL leaked into request path: %q", gotURI)
			}
		})
	}
}

func TestSandboxBindingResponseShapes(t *testing.T) {
	const resource = `{
      "id":"sbind_1",
      "sandbox_id":"sb_1",
      "target_namespace":"github",
      "target_kind":"pull_request",
      "target_id":"123:42",
      "target_url":"https://github.com/acme/widgets/pull/42",
      "relationship":"workspace",
      "metadata":{"color":"blue"},
      "system_metadata":{"repository_id":123},
      "created_by_kind":"user",
      "created_by_id":"user_1",
      "created_at":"2026-09-09T00:00:00.000Z",
      "updated_at":"2026-09-09T01:00:00.000Z"
    }`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch request.Method {
		case http.MethodPost:
			_, _ = io.WriteString(w, `{"id":"sbind_1"}`)
		case http.MethodGet:
			_, _ = io.WriteString(w, `{"items":[`+resource+`]}`)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-token")
	created, err := client.CreateSandboxBinding("box", "https://github.com/acme/widgets/pull/42")
	if err != nil {
		t.Fatalf("CreateSandboxBinding: %v", err)
	}
	if !reflect.DeepEqual(created, &CreateSandboxBindingResponse{ID: "sbind_1"}) {
		t.Errorf("created = %#v", created)
	}

	listed, err := client.ListSandboxBindings()
	if err != nil {
		t.Fatalf("ListSandboxBindings: %v", err)
	}
	if len(listed.Items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(listed.Items))
	}
	item := listed.Items[0]
	if item.ID != "sbind_1" || item.TargetID != "123:42" || item.TargetURL != "https://github.com/acme/widgets/pull/42" {
		t.Errorf("binding = %#v", item)
	}
	if !reflect.DeepEqual(item.Metadata, map[string]any{"color": "blue"}) {
		t.Errorf("metadata = %#v", item.Metadata)
	}
	if !reflect.DeepEqual(item.SystemMetadata, map[string]any{"repository_id": float64(123)}) {
		t.Errorf("system metadata = %#v", item.SystemMetadata)
	}

	roundTrip, err := json.Marshal(listed)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	for _, key := range []string{
		`"sandbox_id"`, `"target_namespace"`, `"target_kind"`, `"target_id"`,
		`"target_url"`, `"relationship"`, `"metadata"`, `"system_metadata"`,
		`"created_by_kind"`, `"created_by_id"`, `"created_at"`, `"updated_at"`,
	} {
		if !strings.Contains(string(roundTrip), key) {
			t.Errorf("round-trip JSON missing %s: %s", key, roundTrip)
		}
	}
}

func TestListSandboxBindingsNormalizesMissingItemsToEmptyArray(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()

	response, err := NewClient(server.URL, "test-token").ListSandboxBindings()
	if err != nil {
		t.Fatalf("ListSandboxBindings: %v", err)
	}
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	if string(encoded) != `{"items":[]}` {
		t.Errorf("encoded = %s, want empty items array", encoded)
	}
}
