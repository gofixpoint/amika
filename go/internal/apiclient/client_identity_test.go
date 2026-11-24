package apiclient

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestClientSetsUserAgentForTheAPI(t *testing.T) {
	var userAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent = r.Header.Get("User-Agent")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "api-token")
	if err := client.doJSON(http.MethodGet, "/api/v0beta1/rigs", nil, nil); err != nil {
		t.Fatal(err)
	}

	want := regexp.MustCompile(`^amika-cli/\S+ \(\w+; \w+; (tty|notty)\)$`)
	if !want.MatchString(userAgent) {
		t.Errorf("User-Agent = %q, want amika-cli/<version> (<os>; <arch>; tty|notty)", userAgent)
	}
}

func TestClientKeepsDefaultUserAgentForOtherHosts(t *testing.T) {
	var userAgent string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent = r.Header.Get("User-Agent")
	}))
	defer other.Close()

	client := NewClient("https://app.amika.dev", "api-token")
	req, err := http.NewRequest(http.MethodGet, other.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.HTTP.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	if strings.HasPrefix(userAgent, "amika-cli/") {
		t.Errorf("User-Agent = %q, want the Go default", userAgent)
	}
}
