package apiclient

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// An APIKeyValue decodes from the API's JSON like any string, but formatting
// it, or a CreatedAPIKey holding it, with any of fmt's usual verbs prints a
// placeholder, so a log line or an error that includes it cannot leak the key.
func TestAPIKeyValueRedactsWhenFormatted(t *testing.T) {
	const secret = "sk_live_should_never_print"
	var created CreatedAPIKey
	body := `{"id":"key_1","name":"n","scope":"organization","obfuscatedValue":"sk_...rint",` +
		`"lastUsedAt":null,"createdAt":"t","updatedAt":"t","value":"` + secret + `"}`
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	if created.Value.Reveal() != secret {
		t.Fatalf("Reveal() = %q, want the decoded key", created.Value.Reveal())
	}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q"} {
		for _, v := range []any{created, &created, created.Value} {
			if got := fmt.Sprintf(verb, v); strings.Contains(got, secret) {
				t.Errorf("fmt.Sprintf(%q, %T) = %q, leaks the key", verb, v, got)
			}
		}
	}
}
