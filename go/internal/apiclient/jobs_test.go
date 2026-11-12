package apiclient

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// recordedRequest is one request a test server saw.
type recordedRequest struct {
	method, uri, body, idempotencyKey string
}

// jobServer answers every request with response and records it.
func jobServer(t *testing.T, response string) (*Client, *[]recordedRequest) {
	t.Helper()
	var requests []recordedRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, recordedRequest{r.Method, r.URL.RequestURI(), string(body), r.Header.Get("Idempotency-Key")})
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, "tok"), &requests
}

func TestJobRequestPaths(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantURI    string
	}{
		{"GetJob by ref", func(c *Client) error { _, err := c.GetJob(JobSelector{Value: "nightly"}); return err }, "GET", "/api/v0beta1/jobs/nightly"},
		{"GetJob by id", func(c *Client) error { _, err := c.GetJob(JobSelector{Value: "job_1", By: SelectByID}); return err }, "GET", "/api/v0beta1/jobs/job_1?by=id"},
		{"UpdateJob by name", func(c *Client) error {
			_, err := c.UpdateJob(JobSelector{Value: "a b", By: SelectByName}, map[string]bool{"enabled": false})
			return err
		}, "PATCH", "/api/v0beta1/jobs/a%20b?by=name"},
		{"DeleteJob", func(c *Client) error { return c.DeleteJob(JobSelector{Value: "nightly"}) }, "DELETE", "/api/v0beta1/jobs/nightly"},
		{"ListJobs", func(c *Client) error {
			enabled := false
			_, err := c.ListJobs(ListJobsQuery{Enabled: &enabled, Limit: 100, Cursor: "c1"})
			return err
		}, "GET", "/api/v0beta1/jobs?cursor=c1&enabled=false&limit=100"},
		{"ListJobRuns", func(c *Client) error {
			_, err := c.ListJobRuns(ListJobRunsQuery{Job: JobSelector{Value: "nightly", By: SelectByName}, Status: "failed", TriggerKind: "cron", Limit: 5})
			return err
		}, "GET", "/api/v0beta1/job-runs?job_name=nightly&limit=5&status=failed&trigger_kind=cron"},
		{"GetJobRun", func(c *Client) error { _, err := c.GetJobRun("jr_1"); return err }, "GET", "/api/v0beta1/job-runs/jr_1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, requests := jobServer(t, `{}`)
			if err := tt.call(c); err != nil {
				t.Fatal(err)
			}
			got := (*requests)[0]
			if got.method != tt.wantMethod || got.uri != tt.wantURI {
				t.Errorf("got %s %s, want %s %s", got.method, got.uri, tt.wantMethod, tt.wantURI)
			}
		})
	}
}

func TestCreateJobSendsIdempotencyKeyAndBody(t *testing.T) {
	c, requests := jobServer(t, `{"id":"job_1","name":"nightly","steps":[{"rig_ref":"dev","command":"make","timeout_ms":1000}]}`)
	job, err := c.CreateJob(CreateJobRequest{
		Name:    "nightly",
		Trigger: CronTrigger{Kind: "cron", Schedule: "@daily"},
		Steps:   []JobStep{{RigRef: "dev", Command: "make", TimeoutMS: 1000}},
	}, "key-1")
	if err != nil {
		t.Fatal(err)
	}
	got := (*requests)[0]
	if got.idempotencyKey != "key-1" {
		t.Errorf("Idempotency-Key = %q, want key-1", got.idempotencyKey)
	}
	want := `{"name":"nightly","trigger":{"kind":"cron","schedule":"@daily"},"steps":[{"rig_ref":"dev","command":"make","timeout_ms":1000}]}`
	if got.body != want {
		t.Errorf("body = %s\nwant   %s", got.body, want)
	}
	if job.ID != "job_1" || len(job.Steps) != 1 {
		t.Errorf("decoded job = %+v", job)
	}
}

func TestCreateJobRunNamesTheJobByKind(t *testing.T) {
	for _, tt := range []struct {
		sel      JobSelector
		key      string
		wantBody string
	}{
		{JobSelector{Value: "nightly"}, "", `{"job_ref":"nightly"}`},
		{JobSelector{Value: "job_1", By: SelectByID}, "k", `{"job_id":"job_1"}`},
	} {
		c, requests := jobServer(t, `{"id":"jr_1"}`)
		if _, err := c.CreateJobRun(tt.sel, tt.key); err != nil {
			t.Fatal(err)
		}
		got := (*requests)[0]
		if got.method != "POST" || got.uri != "/api/v0beta1/job-runs" || got.body != tt.wantBody || got.idempotencyKey != tt.key {
			t.Errorf("got %+v, want body %s and key %q", got, tt.wantBody, tt.key)
		}
	}
}

// A job's nullable fields stay null, and its steps keep every field, when
// the CLI re-encodes it for -o json.
func TestJobRoundTripsTheAPISchema(t *testing.T) {
	in := `{"id":"job_1","name":"n","description":null,"enabled":false,"trigger":{"kind":"cron","schedule":"@daily","timezone":"UTC"},"steps":[{"rig_create":{"name":"x","resources":{"vcpus":2}},"command":"make","timeout_ms":1}],"rig_status_on_finish":null,"overlap_policy":"skip","next_run_at":null,"created_at":"t0","updated_at":"t1"}`
	var job Job
	if err := json.Unmarshal([]byte(in), &job); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != in {
		t.Errorf("round trip changed the job:\n got %s\nwant %s", out, in)
	}
}
