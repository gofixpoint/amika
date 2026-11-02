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

// hostsBody is the three-host listing the host-command tests run against: one
// ready host with a size, one still waiting for its URL, and one tunnelled,
// which never has one. Neither of the first two carries a transport, as a
// control plane older than the field answers.
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
		{
			"id": "host_3", "hostname": "delta.lan", "url": nil, "org_id": "org_1",
			"sizes": map[string]any{}, "transport_mode": "tunnel",
			"created_at": "2026-01-04T00:00:00Z", "updated_at": "2026-01-04T00:00:00Z",
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
	// Counting the fields is also what pins these cells to one
	// whitespace-free token each, which `rowFor` above and anyone piping
	// this into awk both rely on: a space in the TYPE, TRANSPORT, or URL
	// cell would silently turn one column into two and the count would not
	// be 5. A host that predates host_type is listed as a vm.
	// SIZES is the one cell that can hold a space, since a host names its
	// own sizes and nothing rejects a space in one. It is the last column,
	// so it costs only itself.
	beta := rowFor(t, out, "beta.lan")
	if got := strings.Fields(beta); len(got) != 5 || got[1] != "vm" || got[2] != "listen" ||
		got[3] != "-" || got[4] != "-" {
		t.Errorf("beta.lan row = %q, want a listening vm with its URL and sizes as \"-\"", beta)
	}
	// A tunnelled host shows the same "-" as a listener that never
	// registered; TRANSPORT is what tells them apart, so the column has to
	// be there and has to be right.
	delta := rowFor(t, out, "delta.lan")
	if got := strings.Fields(delta); len(got) != 5 || got[2] != "tunnel" ||
		got[3] != "-" {
		t.Errorf("delta.lan row = %q, want tunnel with its URL as \"-\"", delta)
	}
	// The rows above would still pass if the column were unlabelled, so
	// check the header names it too: that is what tells a reader which of
	// the five fields they are looking at.
	if got := strings.Fields(rowFor(t, out, "HOSTNAME")); !reflect.DeepEqual(got, []string{"HOSTNAME", "TYPE", "TRANSPORT", "URL", "SIZES"}) {
		t.Errorf("header = %q", got)
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
	if len(got) != 3 {
		t.Fatalf("got %d hosts, want 3: %s", len(got), buf.String())
	}
	for field, want := range map[string]string{"id": `"host_1"`, "org_id": `"org_1"`} {
		if string(got[0][field]) != want {
			t.Errorf("got[0][%q] = %s, want %s", field, got[0][field], want)
		}
	}
	// A consumer finds the listening hosts that have not finished registering
	// with `select(.transport_mode == "listen" and .url == null)`. An omitted
	// url key would quietly never match, and a null url on its own also
	// matches every tunnelled host, which is not waiting on anything.
	raw, ok := got[1]["url"]
	if !ok {
		t.Fatalf("a URL-less host must carry an explicit null url: %s", buf.String())
	}
	if string(raw) != "null" {
		t.Errorf("url = %s, want null", raw)
	}
	// The stub answers as a control plane older than `transport_mode` does,
	// omitting it. The schema marks it required, so emitting "" here would
	// put a value in `-o json` that no version of the API produces; it is
	// read as the listener such a plane only ever serves.
	for i, want := range []string{`"listen"`, `"listen"`, `"tunnel"`} {
		if string(got[i]["transport_mode"]) != want {
			t.Errorf("got[%d].transport_mode = %s, want %s",
				i, got[i]["transport_mode"], want)
		}
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

func TestHostGetShowsTheTransport(t *testing.T) {
	stubHostAPI(t)

	// `host get` is where an operator looks when the listing's "-" leaves
	// them unsure, so it has to name the transport rather than make them
	// infer it from a URL that is absent for two different reasons.
	for _, tc := range []struct{ host, want string }{
		{"delta.lan", "Transport:  tunnel"},
		{"alpha.lan", "Transport:  listen"},
	} {
		c, buf := newHostCmd(runHostGet, nil)
		if err := runHostGet(c, []string{tc.host}); err != nil {
			t.Fatalf("runHostGet(%s): %v", tc.host, err)
		}
		if !strings.Contains(buf.String(), tc.want) {
			t.Errorf("%s output %q missing %q", tc.host, buf.String(), tc.want)
		}
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

// bareMetalHostsBody is a listing with one bare-metal host, which offers no
// sizes but reports its detected resources and login account, beside a VM
// host that says so explicitly.
func bareMetalHostsBody() []map[string]any {
	return []map[string]any{
		{
			"id": "host_m", "hostname": "metal.lan", "url": nil, "org_id": "org_1",
			"sizes": map[string]any{}, "transport_mode": "tunnel", "host_type": "bare_metal",
			"detected_resources": map[string]any{
				"vcpus": 10, "memoryGib": 32, "diskGib": 926.5, "os": "darwin", "arch": "arm64",
			},
			"ssh_user":   "Jakub",
			"created_at": "2026-01-05T00:00:00Z", "updated_at": "2026-01-05T00:00:00Z",
		},
		{
			"id": "host_v", "hostname": "vm.lan", "url": "https://vm.example", "org_id": "org_1",
			"sizes": map[string]any{
				"small": map[string]any{"vcpus": 2, "memoryGib": 4, "diskGib": 40, "diskGrowOnly": false},
			},
			"host_type": "vm", "detected_resources": nil, "ssh_user": nil,
			"created_at": "2026-01-06T00:00:00Z", "updated_at": "2026-01-06T00:00:00Z",
		},
	}
}

// serveHosts points the CLI at a control plane whose listing is body.
func serveHosts(t *testing.T, body []map[string]any) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" && r.URL.Path == "/api/v0beta1/hosts" {
			json.NewEncoder(w).Encode(body)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")
}

func TestHostListShowsTypeAndBareMetalResources(t *testing.T) {
	serveHosts(t, bareMetalHostsBody())
	c, buf := newHostCmd(runHostList, nil)
	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	out := buf.String()
	for name, want := range map[string][]string{
		"metal.lan": {"metal.lan", "bare_metal", "tunnel", "-", "10cpu/32GiB/926.5GiB"},
		"vm.lan":    {"vm.lan", "vm", "listen", "https://vm.example", "small"},
	} {
		if got := strings.Fields(rowFor(t, out, name)); !reflect.DeepEqual(got, want) {
			t.Errorf("%s row = %q, want %q", name, got, want)
		}
	}
}

func TestHostGetShowsBareMetalResources(t *testing.T) {
	serveHosts(t, bareMetalHostsBody())
	c, buf := newHostCmd(runHostGet, nil)
	if err := runHostGet(c, []string{"metal.lan"}); err != nil {
		t.Fatalf("runHostGet: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		"Type:       bare_metal",
		"SSH user:   Jakub",
		"CPUs:       10",
		"Memory:     32 GiB",
		"Disk:       926.5 GiB",
		"OS/Arch:    darwin/arm64",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q missing %q", out, want)
		}
	}
	if strings.Contains(out, "Sizes:") {
		t.Errorf("a bare-metal host has no sizes to list: %q", out)
	}

	c, buf = newHostCmd(runHostGet, nil)
	if err := runHostGet(c, []string{"vm.lan"}); err != nil {
		t.Fatalf("runHostGet: %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "Type:       vm") || strings.Contains(out, "SSH user:") || strings.Contains(out, "CPUs:") {
		t.Errorf("vm host output = %q", out)
	}
}

func TestHostJSONRoundTripsBareMetalFields(t *testing.T) {
	serveHosts(t, bareMetalHostsBody())
	c, buf := newHostCmd(runHostList, nil)
	c.Flags().Set(output.FlagName, "json")
	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	var got []map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("decoding %q: %v", buf.String(), err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d hosts, want 2", len(got))
	}
	for field, want := range map[string]string{
		"host_type":          `"bare_metal"`,
		"ssh_user":           `"Jakub"`,
		"detected_resources": `{"vcpus":10,"memoryGib":32,"diskGib":926.5,"os":"darwin","arch":"arm64"}`,
	} {
		if string(got[0][field]) != want {
			t.Errorf("metal %s = %s, want %s", field, got[0][field], want)
		}
	}
	// Nullable fields stay explicit nulls rather than disappearing.
	for field, want := range map[string]string{
		"host_type":          `"vm"`,
		"ssh_user":           "null",
		"detected_resources": "null",
	} {
		raw, ok := got[1][field]
		if !ok || string(raw) != want {
			t.Errorf("vm %s = %s (present %v), want %s", field, raw, ok, want)
		}
	}
}

// A control plane older than host_type omits it; every host it registers is
// a VM host, and -o json must say so rather than emit "".
func TestHostJSONReadsMissingHostTypeAsVM(t *testing.T) {
	stubHostAPI(t)
	c, buf := newHostCmd(runHostList, nil)
	c.Flags().Set(output.FlagName, "json")
	if err := runHostList(c, nil); err != nil {
		t.Fatalf("runHostList: %v", err)
	}
	var got []map[string]json.RawMessage
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("decoding %q: %v", buf.String(), err)
	}
	for i, h := range got {
		if string(h["host_type"]) != `"vm"` {
			t.Errorf("got[%d].host_type = %s, want \"vm\"", i, h["host_type"])
		}
	}
}
