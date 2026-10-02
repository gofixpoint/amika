package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/spf13/cobra"
)

// hostsBody is the two-host listing the host-command tests run against: one
// ready host with a size, one still waiting for its URL.
func hostsBody() []map[string]any {
	return []map[string]any{
		{
			"id": "host_1", "hostname": "alpha.lan", "url": "https://alpha.example",
			"org_id": "org_1",
			"sizes": map[string]any{
				"small": map[string]any{"vcpus": 2, "memoryGib": 4, "diskGib": 40, "diskGrowOnly": false},
				"big":   map[string]any{"vcpus": 16, "memoryGib": 1.5, "diskGib": 200, "diskGrowOnly": true},
			},
			"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
		},
		{
			"id": "host_2", "hostname": "beta.lan", "url": nil, "org_id": "org_1",
			"sizes":      map[string]any{},
			"created_at": "2026-01-03T00:00:00Z", "updated_at": "2026-01-03T00:00:00Z",
		},
	}
}

// hostAPIStub is a fake control plane serving hostsBody, recording what the
// CLI asked it. The recorder is mutex-guarded: the handler runs on the test
// server's goroutine while the test body reads the log.
type hostAPIStub struct {
	mu sync.Mutex
	// deleteStatus is what DELETE /hosts/{id} answers; 409 is the control
	// plane refusing to delete a host that still carries rigs.
	deleteStatus int
	requests     []string
}

func (s *hostAPIStub) record(entry string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, entry)
}

func (s *hostAPIStub) saw(want string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.requests {
		if r == want {
			return true
		}
	}
	return false
}

func (s *hostAPIStub) log() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.requests...)
}

// stubHostAPI points the CLI's client and its auth at a fake control plane.
func stubHostAPI(t *testing.T) *hostAPIStub {
	t.Helper()
	stub := &hostAPIStub{deleteStatus: http.StatusNoContent}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.record(r.Method + " " + r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v0beta1/hosts":
			json.NewEncoder(w).Encode(hostsBody())
		case r.Method == "DELETE":
			stub.mu.Lock()
			status := stub.deleteStatus
			stub.mu.Unlock()
			w.WriteHeader(status)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")
	return stub
}

// newHostCmd builds a bare command carrying one host subcommand's flags, so
// its RunE can be exercised without the root command's flag state.
func newHostCmd(run func(*cobra.Command, []string) error, flags func(*cobra.Command)) (*cobra.Command, *bytes.Buffer) {
	c := &cobra.Command{RunE: run}
	c.Flags().String(output.FlagName, "text", "")
	if flags != nil {
		flags(c)
	}
	var buf bytes.Buffer
	c.SetOut(&buf)
	return c, &buf
}

func TestHostListText(t *testing.T) {
	stubHostAPI(t)
	c, buf := newHostCmd(runHostList, nil)

	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "alpha.lan") || !strings.Contains(out, "https://alpha.example") {
		t.Errorf("output = %q", out)
	}
	// Sizes are a map, so they are printed in a stable order, not JSON's.
	if !strings.Contains(out, "big,small") {
		t.Errorf("sizes not sorted in %q", out)
	}
	// A host with no URL and no sizes still gets a row, with "-" in both —
	// blank cells would hide the very thing the listing exists to show.
	beta := rowFor(t, out, "beta.lan")
	if got := strings.Fields(beta); len(got) != 3 || got[1] != "-" || got[2] != "-" {
		t.Errorf("beta.lan row = %q, want its URL and sizes as \"-\"", beta)
	}
	// Ids are not a listing column; `host get` and -o json carry them.
	if strings.Contains(out, "host_1") {
		t.Errorf("listing should not carry ids: %q", out)
	}
}

func TestHostListJSONEmitsTheAPIShape(t *testing.T) {
	stubHostAPI(t)
	c, buf := newHostCmd(runHostList, nil)
	c.Flags().Set(output.FlagName, "json")

	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	// Decoded as RawMessage, not `any`: a map[string]any yields nil both for
	// a JSON null and for a key that is not there, so it cannot pin the
	// "nullable means an explicit null, never omitted" rule below.
	var got []map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("decoding %q: %v", buf.String(), err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d hosts, want 2: %s", len(got), buf.String())
	}
	for field, want := range map[string]string{"id": `"host_1"`, "org_id": `"org_1"`} {
		if string(got[0][field]) != want {
			t.Errorf("got[0][%q] = %s, want %s", field, got[0][field], want)
		}
	}
	// A consumer finds the hosts that have not finished registering with
	// `select(.url == null)`, which an omitted key would quietly never match.
	raw, ok := got[1]["url"]
	if !ok {
		t.Fatalf("a URL-less host must carry an explicit null url: %s", buf.String())
	}
	if string(raw) != "null" {
		t.Errorf("url = %s, want null", raw)
	}
}

// An org with no hosts yet must still emit `[]`, not `null`: a 200 with an
// empty body decodes to a nil slice, and `| jq 'length'` on null errors out.
func TestHostListJSONEmitsAnEmptyArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")

	c, buf := newHostCmd(runHostList, nil)
	c.Flags().Set(output.FlagName, "json")

	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	if got := strings.TrimSpace(buf.String()); got != "[]" {
		t.Errorf("output = %q, want []", got)
	}
}

func TestHostGetResolvesByHostname(t *testing.T) {
	stub := stubHostAPI(t)
	c, buf := newHostCmd(runHostGet, nil)

	if err := runHostGet(c, []string{"alpha.lan"}); err != nil {
		t.Fatalf("runHostGet: %v", err)
	}
	// A hostname is resolved through the listing; the API's own routes take
	// only ids, so nothing should have been fetched by name.
	for _, r := range stub.log() {
		if strings.HasPrefix(r, "GET /api/v0beta1/hosts/") {
			t.Errorf("unexpected request %q", r)
		}
	}
	out := buf.String()
	for _, want := range []string{"alpha.lan", "host_1"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q missing %q", out, want)
		}
	}
	// Each size's own row, column by column: a swapped or dropped field here
	// is the kind of thing a "contains the name" assertion sails past. `big`
	// is grow-only and has a fractional memory, so the "≥" marker and the
	// non-exponent float format are both covered.
	for _, want := range []struct{ name, row string }{
		{"small", "small 2 4 GiB 40 GiB"},
		{"big", "big 16 1.5 GiB ≥ 200 GiB"},
	} {
		if got := strings.Join(strings.Fields(rowFor(t, out, want.name)), " "); got != want.row {
			t.Errorf("%s row = %q, want %q", want.name, got, want.row)
		}
	}
}

// rowFor returns the line of out whose first field is name.
func rowFor(t *testing.T, out, name string) string {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if fields := strings.Fields(line); len(fields) > 0 && fields[0] == name {
			return line
		}
	}
	t.Fatalf("no row for %q in:\n%s", name, out)
	return ""
}

func TestHostGetUnknownNamesTheKnownHosts(t *testing.T) {
	stubHostAPI(t)
	c, _ := newHostCmd(runHostGet, nil)

	err := runHostGet(c, []string{"gamma.lan"})
	if err == nil || !strings.Contains(err.Error(), "alpha.lan") {
		t.Errorf("err = %v, want one naming the known hosts", err)
	}
}

func TestHostDeleteResolvesNamesAndDeletesByID(t *testing.T) {
	stub := stubHostAPI(t)
	c, buf := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	c.Flags().Set("force", "true")

	if err := runHostDelete(c, []string{"alpha.lan"}); err != nil {
		t.Fatalf("runHostDelete: %v", err)
	}
	if !stub.saw("DELETE /api/v0beta1/hosts/host_1") {
		t.Errorf("requests = %v", stub.log())
	}
	if !strings.Contains(buf.String(), "deleted") {
		t.Errorf("output = %q", buf.String())
	}
}

// Two refs can name one host. It is deleted once -- a second DELETE would 404
// on the host this command just removed -- but each ref still gets a result,
// since callers line the array up against the arguments they passed.
func TestHostDeleteDeletesEachHostOnce(t *testing.T) {
	stub := stubHostAPI(t)
	c, buf := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	c.Flags().Set("force", "true")
	c.Flags().Set(output.FlagName, "json")

	if err := runHostDelete(c, []string{"alpha.lan", "host_1"}); err != nil {
		t.Fatalf("runHostDelete: %v", err)
	}
	var deletes, listings int
	for _, r := range stub.log() {
		switch r {
		case "DELETE /api/v0beta1/hosts/host_1":
			deletes++
		case "GET /api/v0beta1/hosts":
			listings++
		}
	}
	if deletes != 1 {
		t.Errorf("DELETE count = %d, want 1 (requests: %v)", deletes, stub.log())
	}
	// And one listing for the whole command, not one per ref.
	if listings != 1 {
		t.Errorf("listing count = %d, want 1", listings)
	}

	var results []output.ItemResult
	if err := json.Unmarshal(buf.Bytes(), &results); err != nil {
		t.Fatalf("decoding %q: %v", buf.String(), err)
	}
	want := []output.ItemResult{
		{Name: "alpha.lan", Status: "deleted"},
		{Name: "host_1", Status: "deleted"},
	}
	if !reflect.DeepEqual(results, want) {
		t.Errorf("results = %+v, want %+v", results, want)
	}
}

// A refused delete must not be retried by a second ref naming the same host:
// the control plane would take a second write and refuse it again. Both refs
// still report the refusal — one result per argument is the contract, and the
// dedup is about the request, not the reporting.
func TestHostDeleteDoesNotRetryARefusedHost(t *testing.T) {
	stub := stubHostAPI(t)
	stub.deleteStatus = http.StatusConflict
	c, buf := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	c.Flags().Set("force", "true")
	c.Flags().Set(output.FlagName, "json")

	err := runHostDelete(c, []string{"alpha.lan", "host_1"})
	if err == nil || !strings.Contains(err.Error(), "2 of 2") {
		t.Errorf("err = %v, want both refs reported as failed", err)
	}
	var deletes int
	for _, r := range stub.log() {
		if r == "DELETE /api/v0beta1/hosts/host_1" {
			deletes++
		}
	}
	if deletes != 1 {
		t.Errorf("DELETE count = %d, want 1 (requests: %v)", deletes, stub.log())
	}

	// Both refs still get a result, carrying the same refusal.
	var results []output.ItemResult
	if err := json.Unmarshal(buf.Bytes(), &results); err != nil {
		t.Fatalf("decoding %q: %v", buf.String(), err)
	}
	if len(results) != 2 {
		t.Fatalf("results = %+v, want one per argument", results)
	}
	for _, r := range results {
		if r.Status != "error" || !strings.Contains(r.Error, "409") {
			t.Errorf("result = %+v, want the 409 on both", r)
		}
	}
}

// A logged-out delete must say so instead of asking the operator to approve
// something that cannot run, and instead of failing on an unreadable prompt.
func TestHostDeleteChecksAuthBeforePrompting(t *testing.T) {
	stubHostAPI(t)
	t.Setenv("AMIKA_API_KEY", "")
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	c, _ := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	// No input to read: a prompt would fail on EOF rather than on auth.
	c.SetIn(strings.NewReader(""))

	// Reaching the prompt would fail on the empty stdin with "failed to read
	// confirmation: EOF" instead, so the message is what pins the ordering.
	err := runHostDelete(c, []string{"alpha.lan"})
	if err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Errorf("err = %v, want the login error", err)
	}
}

// With bring-your-own-compute off the whole /hosts surface 404s, so the
// listing has to happen before the prompt: otherwise the operator approves a
// delete that cannot run, and a non-interactive caller reports the unreadable
// prompt instead of the real failure.
func TestHostDeleteListsBeforePrompting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":{"code":"invalid_api_route"}}`)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")

	c, _ := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	// No input: reaching the prompt would fail on EOF instead.
	c.SetIn(strings.NewReader(""))

	err := runHostDelete(c, []string{"alpha.lan"})
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("err = %v, want the listing failure", err)
	}
	if err != nil && strings.Contains(err.Error(), "confirmation") {
		t.Errorf("prompted before listing: %v", err)
	}
}

// Size names are only `z.string().min(1)` server-side, so one carrying a
// newline would end the tabwriter's column block and misalign every row
// after it, not just its own.
func TestHostListKeepsOneRowPerHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `[
		  {"id":"host_1","hostname":"alpha.lan","url":"https://a.example","org_id":"org_1",
		   "sizes":{"sm\nall":{"vcpus":2,"memoryGib":4,"diskGib":40,"diskGrowOnly":false}},
		   "created_at":"","updated_at":""},
		  {"id":"host_2","hostname":"beta.lan","url":"https://b.example","org_id":"org_1",
		   "sizes":{"big":{"vcpus":16,"memoryGib":64,"diskGib":200,"diskGrowOnly":false}},
		   "created_at":"","updated_at":""}
		]`)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")

	c, buf := newHostCmd(runHostList, nil)
	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Errorf("got %d lines, want a header and one row per host:\n%s", len(lines), buf.String())
	}
}

func TestHostDeleteRefusesToPromptInJSON(t *testing.T) {
	stubHostAPI(t)
	c, _ := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	c.Flags().Set(output.FlagName, "json")

	err := runHostDelete(c, []string{"alpha.lan"})
	if err == nil || !strings.Contains(err.Error(), "--force") {
		t.Errorf("err = %v, want the refusal to prompt", err)
	}
}

func TestHostDeleteReportsPerHostFailures(t *testing.T) {
	stubHostAPI(t)
	c, buf := newHostCmd(runHostDelete, func(c *cobra.Command) {
		c.Flags().BoolP("force", "f", false, "")
	})
	c.Flags().Set("force", "true")
	c.Flags().Set(output.FlagName, "json")

	err := runHostDelete(c, []string{"alpha.lan", "gamma.lan"})
	if err == nil || !strings.Contains(err.Error(), "1 of 2") {
		t.Errorf("err = %v", err)
	}
	var results []output.ItemResult
	if err := json.Unmarshal(buf.Bytes(), &results); err != nil {
		t.Fatalf("decoding %q: %v", buf.String(), err)
	}
	if len(results) != 2 || results[0].Status != "deleted" || results[1].Status != "error" {
		t.Errorf("results = %+v", results)
	}
}
