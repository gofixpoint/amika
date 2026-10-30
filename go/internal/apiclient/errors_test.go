package apiclient

import "testing"

// TestHTTPErrorUserMessage covers how a non-2xx body becomes the text a user
// reads: the API's envelope, a route's schema rejection (which skips the
// envelope), and anything else verbatim.
func TestHTTPErrorUserMessage(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "envelope with code",
			body: `{"type":"error","error_code":"validation_failed","message":"Model opus is not available for agent codex"}`,
			want: "validation_failed: Model opus is not available for agent codex",
		},
		{
			name: "envelope without code",
			body: `{"message":"busy"}`,
			want: "busy",
		},
		{
			// What `amika send --model gpt-4` gets back today: Hono's zod
			// validator body, with zod 4's issues as a JSON string.
			name: "zod 4 schema rejection",
			body: `{"success":false,"error":{"name":"ZodError","message":"[\n  {\n    \"code\": \"invalid_value\",\n    \"values\": [\"fable\", \"opus\"],\n    \"path\": [\"model\"],\n    \"message\": \"Invalid option: expected one of \\\"fable\\\"|\\\"opus\\\"\"\n  }\n]"}}`,
			want: `Validation failed: model: Invalid option: expected one of "fable"|"opus"`,
		},
		{
			name: "zod 3 schema rejection with nested path and two issues",
			body: `{"success":false,"error":{"name":"ZodError","issues":[{"path":["items",0,"name"],"message":"Required"},{"path":[],"message":"Too many fields"}]}}`,
			want: "Validation failed: items.0.name: Required; Too many fields",
		},
		{
			name: "success false with unreadable error falls back to the body",
			body: `{"success":false,"error":{"message":"not json"}}`,
			want: `{"success":false,"error":{"message":"not json"}}`,
		},
		{
			name: "plain text",
			body: "upstream timeout",
			want: "upstream timeout",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := (&HTTPError{StatusCode: 400, Body: tc.body}).UserMessage()
			if got != tc.want {
				t.Errorf("UserMessage() = %q, want %q", got, tc.want)
			}
		})
	}
}
