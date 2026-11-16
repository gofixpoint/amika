package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testJobJSON = `{"id":"job_1","name":"nightly","description":null,"enabled":true,
"trigger":{"kind":"cron","schedule":"0 2 * * *","timezone":"Europe/Warsaw"},
"steps":[{"rig_name":"dev","command":"make test","timeout_ms":3600000},{"command":"make lint\nmore","timeout_ms":60000}],
"rig_status_on_finish":null,"overlap_policy":"skip","next_run_at":"2026-11-13T01:00:00Z",
"created_at":"2026-11-12T00:00:00Z","updated_at":"2026-11-12T00:00:00Z"}`

// jobAPIRequest is one request the fake jobs API saw.
type jobAPIRequest struct {
	method, uri, body, idempotencyKey string
}

// serveJobsAPI points the CLI at a fake API that answers with respond and
// records every request.
func serveJobsAPI(t *testing.T, respond func(r *http.Request) string) *[]jobAPIRequest {
	t.Helper()
	var requests []jobAPIRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, jobAPIRequest{r.Method, r.URL.RequestURI(), string(body), r.Header.Get("Idempotency-Key")})
		_, _ = io.WriteString(w, respond(r))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_KEY", "test-key")
	t.Setenv("AMIKA_API_URL", srv.URL)
	return &requests
}

func TestJobCreateFromFlags(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testJobJSON })

	out, err := runRootCommandOutput(t, "job", "create", "nightly",
		"--schedule", "0 2 * * *", "--timezone", "Europe/Warsaw", "--rig", "name=dev",
		"--command", "make test", "--command", "make lint", "--timeout", "10m",
		"--session", "jobs", "--rig-status-on-finish", "stopped", "--paused")
	if err != nil {
		t.Fatalf("job create: %v\n%s", err, out)
	}
	got := (*requests)[0]
	if got.method != "POST" || got.uri != "/api/v0beta1/jobs" {
		t.Fatalf("got %s %s", got.method, got.uri)
	}
	if len(got.idempotencyKey) != 32 {
		t.Errorf("Idempotency-Key = %q, want a generated 32-character key", got.idempotencyKey)
	}
	want := `{"name":"nightly","trigger":{"kind":"cron","schedule":"0 2 * * *","timezone":"Europe/Warsaw"},` +
		`"steps":[{"rig_name":"dev","session":"jobs","command":"make test","timeout_ms":600000},` +
		`{"session":"jobs","command":"make lint","timeout_ms":600000}],"rig_status_on_finish":"stopped","enabled":false}`
	if got.body != want {
		t.Errorf("body = %s\nwant   %s", got.body, want)
	}
	for _, s := range []string{`Job "nightly" created`, "0 2 * * * (Europe/Warsaw)", "make lint …"} {
		if !strings.Contains(out, s) {
			t.Errorf("output lacks %q:\n%s", s, out)
		}
	}
}

func TestJobCreateFromFileSendsItUnchanged(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testJobJSON })
	body := `{"name":"nightly","trigger":{"kind":"cron","schedule":"@daily"},"steps":[{"rig_create":{"name":"n","repo_url":"https://github.com/o/r"},"command":"make","timeout_ms":1}]}`
	path := filepath.Join(t.TempDir(), "job.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := runRootCommandOutput(t, "job", "create", "--file", path, "--idempotency-key", "k1", "-o", "json"); err != nil {
		t.Fatal(err)
	}
	got := (*requests)[0]
	if got.body != body || got.idempotencyKey != "k1" {
		t.Errorf("got body %s, key %q", got.body, got.idempotencyKey)
	}
}

func TestJobCreateUsageErrorsMakeNoRequest(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testJobJSON })
	for _, tt := range []struct {
		args []string
		want string
	}{
		{[]string{"job", "create", "--file", "x.json", "--schedule", "@daily"}, "--file cannot be combined with --schedule"},
		{[]string{"job", "create", "n", "--file", "x.json"}, "do not pass <name>"},
		{[]string{"job", "create", "n", "--rig", "dev", "--command", "x"}, "--schedule is required"},
		{[]string{"job", "create", "n", "--schedule", "@daily", "--command", "x"}, "--rig is required"},
		{[]string{"job", "create", "n", "--schedule", "@daily", "--rig", "dev"}, "--command is required"},
		{[]string{"job", "create", "n", "--schedule", "@daily", "--rig", "dev", "--command", "x", "--timeout", "0s"}, "--timeout"},
	} {
		_, err := runRootCommandOutput(t, tt.args...)
		if err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Errorf("%v: err = %v, want it to contain %q", tt.args, err, tt.want)
		}
	}
	if len(*requests) != 0 {
		t.Errorf("usage errors made %d requests", len(*requests))
	}
}

// The API replaces the whole trigger, so changing only the schedule must
// keep the job's time zone rather than reset it to UTC.
func TestJobUpdateScheduleKeepsTimezone(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testJobJSON })

	if _, err := runRootCommandOutput(t, "job", "update", "id=job_1", "--schedule", "@hourly", "--description", ""); err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 2 || (*requests)[0].method != "GET" {
		t.Fatalf("want a GET then a PATCH, got %+v", *requests)
	}
	patch := (*requests)[1]
	if patch.method != "PATCH" || patch.uri != "/api/v0beta1/jobs/job_1?by=id" {
		t.Fatalf("got %s %s", patch.method, patch.uri)
	}
	var body map[string]interface{}
	if err := json.Unmarshal([]byte(patch.body), &body); err != nil {
		t.Fatal(err)
	}
	trigger, _ := body["trigger"].(map[string]interface{})
	if trigger["schedule"] != "@hourly" || trigger["timezone"] != "Europe/Warsaw" {
		t.Errorf("trigger = %v", trigger)
	}
	if d, ok := body["description"]; !ok || d != nil {
		t.Errorf("an empty --description must send null, body = %s", patch.body)
	}
}

func TestJobPauseAndResume(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return testJobJSON })
	if _, err := runRootCommandOutput(t, "job", "pause", "nightly"); err != nil {
		t.Fatal(err)
	}
	if _, err := runRootCommandOutput(t, "job", "resume", "nightly"); err != nil {
		t.Fatal(err)
	}
	if (*requests)[0].body != `{"enabled":false}` || (*requests)[1].body != `{"enabled":true}` {
		t.Errorf("got %+v", *requests)
	}
}

func TestJobListFollowsEveryPage(t *testing.T) {
	requests := serveJobsAPI(t, func(r *http.Request) string {
		if r.URL.Query().Get("cursor") == "" {
			return `{"items":[` + testJobJSON + `],"next_cursor":"c2"}`
		}
		return `{"items":[` + strings.Replace(testJobJSON, `"nightly"`, `"weekly"`, 1) + `],"next_cursor":null}`
	})

	out, err := runRootCommandOutput(t, "job", "list", "--paused", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 2 || !strings.Contains((*requests)[1].uri, "cursor=c2") || !strings.Contains((*requests)[0].uri, "enabled=false") {
		t.Fatalf("requests = %+v", *requests)
	}
	var page struct {
		Items      []struct{ Name string } `json:"items"`
		NextCursor *string                 `json:"next_cursor"`
	}
	if err := json.Unmarshal([]byte(out), &page); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if len(page.Items) != 2 || page.Items[1].Name != "weekly" || page.NextCursor != nil {
		t.Errorf("page = %+v", page)
	}
}

func TestJobDeleteJSONRequiresForce(t *testing.T) {
	requests := serveJobsAPI(t, func(*http.Request) string { return "" })
	if _, err := runRootCommandOutput(t, "job", "delete", "nightly", "-o", "json"); err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a --force refusal", err)
	}
	out, err := runRootCommandOutput(t, "job", "delete", "nightly", "--force", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if len(*requests) != 1 || (*requests)[0].method != "DELETE" {
		t.Fatalf("requests = %+v", *requests)
	}
	if strings.TrimSpace(out) != `[{"name":"nightly","status":"deleted"}]` {
		t.Errorf("out = %s", out)
	}
}

func TestJobRunAndRuns(t *testing.T) {
	run := `{"id":"jr_1","job_id":"job_1","trigger_kind":"manual","scheduled_at":"t","status":"running","current_step":1,"step_count":2,"command_run_ids":["cr_1","cr_2"],"finish_command_run_id":null,"error":null,"rig_id":"r1","rig_name":"dev","created_at":"t","updated_at":"t","completed_at":null}`
	requests := serveJobsAPI(t, func(r *http.Request) string {
		if r.Method == "GET" && r.URL.Path == "/api/v0beta1/job-runs" {
			return `{"items":[` + run + `],"next_cursor":null}`
		}
		return run
	})

	out, err := runRootCommandOutput(t, "job", "run", "name=nightly")
	if err != nil {
		t.Fatal(err)
	}
	if (*requests)[0].body != `{"job_name":"nightly"}` || !strings.Contains(out, "Job run jr_1 started") || !strings.Contains(out, "2/2") {
		t.Errorf("request %+v, out:\n%s", (*requests)[0], out)
	}

	out, err = runRootCommandOutput(t, "job", "runs", "list", "--job", "nightly", "--status", "running")
	if err != nil {
		t.Fatal(err)
	}
	if (*requests)[1].uri != "/api/v0beta1/job-runs?job_ref=nightly&status=running" || !strings.Contains(out, "jr_1") {
		t.Errorf("request %+v, out:\n%s", (*requests)[1], out)
	}

	if _, err := runRootCommandOutput(t, "job", "runs", "get", "jr_1"); err != nil {
		t.Fatal(err)
	}
	if (*requests)[2].uri != "/api/v0beta1/job-runs/jr_1" {
		t.Errorf("request %+v", (*requests)[2])
	}
}

func TestJobCreateHelpShowsBothForms(t *testing.T) {
	out, err := runRootCommandOutput(t, "job", "create", "--help")
	if err != nil {
		t.Fatal(err)
	}
	want := "Usage:\n" +
		"  amika job create <name> --schedule <cron> --rig <rig> --command <command>... [flags]\n" +
		"  amika job create --file <path> [flags]\n"
	if !strings.Contains(out, want) {
		t.Errorf("help lacks\n%s\ngot:\n%s", want, out)
	}
}
