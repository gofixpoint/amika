package apiclient

// jobs.go calls the cron jobs API: /jobs and /job-runs (amika-mono's
// specs/030-cron-jobs.md). A job is a cron trigger plus an ordered list of
// steps, each a Command Run request; a job run executes them on one rig.

import (
	"encoding/json"
	"net/url"
	"strconv"
)

// JobSelector names one job: Value is matched against the field By names
// (SelectByRef, SelectByName, or SelectByID; empty means SelectByRef).
type JobSelector struct {
	Value string
	By    string
}

// kind returns the selector's kind with the empty default spelled out.
func (s JobSelector) kind() string {
	if s.By == "" {
		return SelectByRef
	}
	return s.By
}

// path builds /jobs/{job}. `by` defaults to ref there, so a ref selector
// leaves it off the wire.
func (s JobSelector) path() string {
	path := apiBasePath + "/jobs/" + url.PathEscape(s.Value)
	if k := s.kind(); k != SelectByRef {
		path += "?by=" + url.QueryEscape(k)
	}
	return path
}

// field returns the body or filter field that names the job by s's kind:
// job_ref, job_name, or job_id.
func (s JobSelector) field() string {
	return "job_" + s.kind()
}

// CronTrigger is the trigger of a create or update request. An empty
// Timezone is omitted, and the server reads the schedule in UTC.
type CronTrigger struct {
	Kind     string `json:"kind"`
	Schedule string `json:"schedule"`
	Timezone string `json:"timezone,omitempty"`
}

// JobTrigger mirrors the API's JobTrigger schema in a response, where the
// time zone is always set.
type JobTrigger struct {
	Kind     string `json:"kind"`
	Schedule string `json:"schedule"`
	Timezone string `json:"timezone"`
}

// JobStep is one step of a create request: a CreateCommandRunRequest body
// without rig_status_on_finish. Only step 0 names a rig, with exactly one of
// RigRef, RigName, RigID, and RigCreate.
type JobStep struct {
	RigRef  string `json:"rig_ref,omitempty"`
	RigName string `json:"rig_name,omitempty"`
	RigID   string `json:"rig_id,omitempty"`
	// RigCreate is a POST /rigs body; each job run creates a rig named after
	// its name, plus a suffix.
	RigCreate      json.RawMessage `json:"rig_create,omitempty"`
	Session        string          `json:"session,omitempty"`
	Command        string          `json:"command"`
	TimeoutMS      int64           `json:"timeout_ms"`
	QueueTimeoutMS int64           `json:"queue_timeout_ms,omitempty"`
	CWD            string          `json:"cwd,omitempty"`
}

// CreateJobRequest is the request body for POST /api/v0beta1/jobs.
type CreateJobRequest struct {
	Name              string      `json:"name"`
	Description       string      `json:"description,omitempty"`
	Trigger           CronTrigger `json:"trigger"`
	Steps             []JobStep   `json:"steps"`
	RigStatusOnFinish string      `json:"rig_status_on_finish,omitempty"`
	OverlapPolicy     string      `json:"overlap_policy,omitempty"`
	Enabled           *bool       `json:"enabled,omitempty"`
}

// Job mirrors the API's Job schema. Steps stay raw, so `-o json` echoes
// every field of a step, including the ones JobStep does not model.
type Job struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	Description       *string           `json:"description"`
	Enabled           bool              `json:"enabled"`
	Trigger           JobTrigger        `json:"trigger"`
	Steps             []json.RawMessage `json:"steps"`
	RigStatusOnFinish *string           `json:"rig_status_on_finish"`
	OverlapPolicy     string            `json:"overlap_policy"`
	// NextRunAt is null while the job is paused.
	NextRunAt *string `json:"next_run_at"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// ListJobsResponse mirrors the API's ListJobsResponse schema. NextCursor is
// null on the last page.
type ListJobsResponse struct {
	Items      []Job   `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// ListJobsQuery filters GET /jobs. A nil Enabled lists enabled and paused
// jobs; a zero Limit uses the server's default.
type ListJobsQuery struct {
	Enabled *bool
	Limit   int
	Cursor  string
}

// JobRun mirrors the API's JobRun schema.
type JobRun struct {
	ID                 string   `json:"id"`
	JobID              string   `json:"job_id"`
	TriggerKind        string   `json:"trigger_kind"`
	ScheduledAt        string   `json:"scheduled_at"`
	Status             string   `json:"status"`
	CurrentStep        int      `json:"current_step"`
	StepCount          int      `json:"step_count"`
	CommandRunIDs      []string `json:"command_run_ids"`
	FinishCommandRunID *string  `json:"finish_command_run_id"`
	Error              *string  `json:"error"`
	RigID              *string  `json:"rig_id"`
	RigName            *string  `json:"rig_name"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at"`
	CompletedAt        *string  `json:"completed_at"`
}

// ListJobRunsResponse mirrors the API's ListJobRunsResponse schema.
type ListJobRunsResponse struct {
	Items      []JobRun `json:"items"`
	NextCursor *string  `json:"next_cursor"`
}

// ListJobRunsQuery filters GET /job-runs. Zero values do not filter.
type ListJobRunsQuery struct {
	Job         JobSelector
	Status      string
	TriggerKind string
	Limit       int
}

// CreateJob calls POST /api/v0beta1/jobs. body is a CreateJobRequest, or
// the raw JSON of one. A repeated idempotencyKey with the same body returns
// the job it created.
func (c *Client) CreateJob(body interface{}, idempotencyKey string) (*Job, error) {
	var out Job
	headers := map[string]string{"Idempotency-Key": idempotencyKey}
	if err := c.doJSONWithHeaders("POST", apiBasePath+"/jobs", body, &out, headers); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListJobs calls GET /api/v0beta1/jobs and returns one page.
func (c *Client) ListJobs(q ListJobsQuery) (*ListJobsResponse, error) {
	params := url.Values{}
	if q.Enabled != nil {
		params.Set("enabled", strconv.FormatBool(*q.Enabled))
	}
	if q.Limit > 0 {
		params.Set("limit", strconv.Itoa(q.Limit))
	}
	if q.Cursor != "" {
		params.Set("cursor", q.Cursor)
	}
	path := apiBasePath + "/jobs"
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out ListJobsResponse
	if err := c.doJSON("GET", path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetJob calls GET /api/v0beta1/jobs/{job}.
func (c *Client) GetJob(sel JobSelector) (*Job, error) {
	var out Job
	if err := c.doJSON("GET", sel.path(), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateJob calls PATCH /api/v0beta1/jobs/{job}. body holds only the fields
// to change; a null description or rig_status_on_finish clears it.
func (c *Client) UpdateJob(sel JobSelector, body interface{}) (*Job, error) {
	var out Job
	if err := c.doJSON("PATCH", sel.path(), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteJob calls DELETE /api/v0beta1/jobs/{job}.
func (c *Client) DeleteJob(sel JobSelector) error {
	return c.doJSON("DELETE", sel.path(), nil, nil)
}

// CreateJobRun calls POST /api/v0beta1/job-runs to start a job run now. An
// empty idempotencyKey sends none.
func (c *Client) CreateJobRun(sel JobSelector, idempotencyKey string) (*JobRun, error) {
	var headers map[string]string
	if idempotencyKey != "" {
		headers = map[string]string{"Idempotency-Key": idempotencyKey}
	}
	body := map[string]string{sel.field(): sel.Value}
	var out JobRun
	if err := c.doJSONWithHeaders("POST", apiBasePath+"/job-runs", body, &out, headers); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListJobRuns calls GET /api/v0beta1/job-runs, newest first.
func (c *Client) ListJobRuns(q ListJobRunsQuery) (*ListJobRunsResponse, error) {
	params := url.Values{}
	if q.Job.Value != "" {
		params.Set(q.Job.field(), q.Job.Value)
	}
	if q.Status != "" {
		params.Set("status", q.Status)
	}
	if q.TriggerKind != "" {
		params.Set("trigger_kind", q.TriggerKind)
	}
	if q.Limit > 0 {
		params.Set("limit", strconv.Itoa(q.Limit))
	}
	path := apiBasePath + "/job-runs"
	if encoded := params.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var out ListJobRunsResponse
	if err := c.doJSON("GET", path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetJobRun calls GET /api/v0beta1/job-runs/{id}.
func (c *Client) GetJobRun(id string) (*JobRun, error) {
	var out JobRun
	if err := c.doJSON("GET", apiBasePath+"/job-runs/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
