package apiclient

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// hostsJSON is a two-host listing: one ready, one still without a URL.
const hostsJSON = `[
  {"id":"host_1","hostname":"alpha.lan","url":"https://alpha.example","org_id":"org_1",
   "sizes":{"small":{"vcpus":2,"memoryGib":4,"diskGib":40,"diskGrowOnly":false}},
   "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-02T00:00:00Z"},
  {"id":"host_2","hostname":"beta.lan","url":null,"org_id":"org_1","sizes":{},
   "created_at":"2026-01-03T00:00:00Z","updated_at":"2026-01-03T00:00:00Z"}
]`

func TestHostRequestPaths(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantPath   string
	}{
		{
			name:       "ListHosts",
			call:       func(c *Client) error { _, err := c.ListHosts(); return err },
			wantMethod: "GET",
			wantPath:   "/api/v0beta1/hosts",
		},
		{
			name:       "DeleteHost",
			call:       func(c *Client) error { return c.DeleteHost("host_1") },
			wantMethod: "DELETE",
			wantPath:   "/api/v0beta1/hosts/host_1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod = r.Method
				gotPath = r.RequestURI
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, hostsJSON)
			}))
			defer srv.Close()

			if err := tt.call(NewClient(srv.URL, "test-token")); err != nil {
				t.Fatalf("call: %v", err)
			}
			if gotMethod != tt.wantMethod {
				t.Errorf("method = %q, want %q", gotMethod, tt.wantMethod)
			}
			if gotPath != tt.wantPath {
				t.Errorf("path = %q, want %q", gotPath, tt.wantPath)
			}
		})
	}
}

func TestListHostsDecodesSizesAndNullURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, hostsJSON)
	}))
	defer srv.Close()

	hosts, err := NewClient(srv.URL, "test-token").ListHosts()
	if err != nil {
		t.Fatalf("ListHosts: %v", err)
	}
	if len(hosts) != 2 {
		t.Fatalf("len(hosts) = %d, want 2", len(hosts))
	}
	if hosts[0].URL == nil || *hosts[0].URL != "https://alpha.example" {
		t.Errorf("hosts[0].URL = %v", hosts[0].URL)
	}
	// A host without a URL must stay distinguishable from one at "": it is
	// what every caller checks before putting a rig on it.
	if hosts[1].URL != nil {
		t.Errorf("hosts[1].URL = %v, want nil", hosts[1].URL)
	}
	small, ok := hosts[0].Sizes["small"]
	if !ok {
		t.Fatalf("sizes = %+v, want a \"small\"", hosts[0].Sizes)
	}
	if small.VCPUs != 2 || small.MemoryGiB != 4 || small.DiskGiB != 40 || small.DiskGrowOnly {
		t.Errorf("small = %+v", small)
	}
}

func TestFindHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, hostsJSON)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "test-token")

	for _, ref := range []string{"beta.lan", "host_2"} {
		host, err := c.FindHost(ref)
		if err != nil {
			t.Fatalf("FindHost(%q): %v", ref, err)
		}
		if host.ID != "host_2" {
			t.Errorf("FindHost(%q).ID = %q, want host_2", ref, host.ID)
		}
	}

	// The usual cause is a typo, so the message has to name what does exist.
	_, err := c.FindHost("gamma.lan")
	if err == nil {
		t.Fatal("FindHost on an unknown host: want an error")
	}
	if !strings.Contains(err.Error(), "alpha.lan") || !strings.Contains(err.Error(), "beta.lan") {
		t.Errorf("error = %q, want the known hostnames in it", err)
	}
}

func TestFindHostWithNoHosts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	_, err := NewClient(srv.URL, "test-token").FindHost("alpha.lan")
	if err == nil || !strings.Contains(err.Error(), "no hosts of its own") {
		t.Errorf("error = %v, want one saying the org has no hosts", err)
	}
}
