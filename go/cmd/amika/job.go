package main

// job.go implements the `amika job` command group over the cron jobs API
// (/jobs and /job-runs). A job is a cron schedule plus an ordered list of
// commands that each job run executes on one rig, as Command Runs.

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/cliprompt"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var jobCmd = &cobra.Command{
	Use:     "job",
	Aliases: []string{"jobs"},
	Short:   "Run commands on a rig on a cron schedule (beta)",
	Long: `Run commands on a rig on a cron schedule (beta).

A job is a cron schedule plus an ordered list of steps. Each time a slot comes
due, or ` + "`amika job run`" + ` starts one, the job gets a job run: the steps run one at
a time on one rig, and the job run stops at the first step that fails.

Jobs are in beta. Where they are not enabled, these commands fail with
HTTP 404.

A <job> is a job's name or id, or name=<name> / id=<id> to match one field.`,
}

var jobCreateCmd = &cobra.Command{
	Use:   "create <name> [flags]",
	Short: "Create a job",
	Long: `Create a job.

The flags make a job whose steps all run on an existing rig: one step per
--command, in order. --timeout, --queue-timeout, --session, and --cwd apply to
every step.

For anything else, such as a new rig for each job run, pass the full request
body as JSON with --file (- reads stdin). It takes the API's CreateJobRequest:

  {
    "name": "nightly-audit",
    "trigger": {"kind": "cron", "schedule": "0 9 * * 1-5", "timezone": "Europe/Warsaw"},
    "steps": [
      {"rig_create": {"name": "audit", "repo_url": "https://github.com/org/repo"},
       "command": "pnpm install --frozen-lockfile", "timeout_ms": 600000},
      {"command": "pnpm audit --prod", "timeout_ms": 1800000}
    ],
    "rig_status_on_finish": "deleted"
  }

The schedule is a 5-field cron expression (minute, hour, day of month, month,
day of week) or @hourly, @daily, @weekly, @monthly, @yearly. Fires must be at
least 5 minutes apart.`,
	Example: `  amika job create nightly-tests --schedule "0 2 * * *" --rig dev --command "make test"
  amika job create --file job.json`,
	Args: cobra.MaximumNArgs(1),
	RunE: runJobCreate,
}

// jobCreateUsageTemplate shows both forms of `job create`: from flags, and
// from a JSON body.
const jobCreateUsageTemplate = `Usage:
  {{.CommandPath}} <name> --schedule <cron> --rig <rig> --command <command>... [flags]
  {{.CommandPath}} --file <path> [flags]{{if .HasExample}}

Examples:
{{.Example}}{{end}}{{if .HasAvailableLocalFlags}}

Flags:
{{.LocalFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}{{if .HasAvailableInheritedFlags}}

Global Flags:
{{.InheritedFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}
`

var jobListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List jobs",
	Args:    cobra.NoArgs,
	RunE:    runJobList,
}

var jobGetCmd = &cobra.Command{
	Use:   "get <job>",
	Short: "Show one job",
	Args:  cobra.ExactArgs(1),
	RunE:  runJobGet,
}

var jobUpdateCmd = &cobra.Command{
	Use:   "update <job> [flags]",
	Short: "Change a job",
	Long: `Change a job. Only the given flags change.

To replace the steps, pass a JSON body of the API's UpdateJobRequest with
--file (- reads stdin), e.g. {"steps": [...]}. --file cannot be combined with
the other flags.`,
	Args: cobra.ExactArgs(1),
	RunE: runJobUpdate,
}

var jobPauseCmd = &cobra.Command{
	Use:   "pause <job>",
	Short: "Pause a job's schedule",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runJobSetEnabled(cmd, args[0], false)
	},
}

var jobResumeCmd = &cobra.Command{
	Use:   "resume <job>",
	Short: "Resume a paused job at its next future slot",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runJobSetEnabled(cmd, args[0], true)
	},
}

var jobDeleteCmd = &cobra.Command{
	Use:     "delete <job> [<job>...]",
	Aliases: []string{"rm", "remove"},
	Short:   "Delete one or more jobs and their job runs",
	Long: `Delete one or more jobs and their job runs.

The Command Runs that the job runs created stay. A job with a pending or
running job run is refused: pause it, and try again once the run ends.`,
	Args: cobra.MinimumNArgs(1),
	RunE: runJobDelete,
}

var jobRunCmd = &cobra.Command{
	Use:   "run <job>",
	Short: "Start a job run now, outside the schedule",
	Long: `Start a job run now, outside the schedule.

The job run ignores the job's overlap policy and does not move its next
scheduled run. Follow it with ` + "`amika job runs get <id>`" + `.`,
	Args: cobra.ExactArgs(1),
	RunE: runJobRun,
}

var jobRunsCmd = &cobra.Command{
	Use:   "runs",
	Short: "Inspect job runs",
}

var jobRunsListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List job runs, newest first",
	Args:    cobra.NoArgs,
	RunE:    runJobRunsList,
}

var jobRunsGetCmd = &cobra.Command{
	Use:   "get <job-run-id>",
	Short: "Show one job run",
	Args:  cobra.ExactArgs(1),
	RunE:  runJobRunsGet,
}

// jobCreateStepFlags are the create flags that build the body, which --file
// replaces.
var jobCreateStepFlags = []string{
	"schedule", "timezone", "rig", "command", "timeout", "queue-timeout",
	"session", "cwd", "description", "rig-status-on-finish", "overlap-policy",
	"paused",
}

func runJobCreate(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	body, err := jobCreateBody(cmd, args)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	key, _ := cmd.Flags().GetString("idempotency-key")
	if key == "" {
		key, err = randomIdempotencyKey()
		if err != nil {
			return err
		}
	}
	job, err := runmode.NewRemoteClient().CreateJob(body, key)
	if err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), job)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Job %q created\n\n", job.Name)
	return writeJob(cmd.OutOrStdout(), job)
}

// jobCreateBody builds the create request from --file or from the flags.
// It runs before the auth check, so a usage error reports itself.
func jobCreateBody(cmd *cobra.Command, args []string) (interface{}, error) {
	flags := cmd.Flags()
	if file, _ := flags.GetString("file"); file != "" {
		if len(args) > 0 {
			return nil, fmt.Errorf("--file gives the job's name; do not pass <name> too")
		}
		for _, name := range jobCreateStepFlags {
			if flags.Changed(name) {
				return nil, fmt.Errorf("--file cannot be combined with --%s", name)
			}
		}
		return readJSONObject(cmd, file)
	}

	if len(args) == 0 {
		return nil, fmt.Errorf("requires a job name, or --file")
	}
	schedule, _ := flags.GetString("schedule")
	rawRig, _ := flags.GetString("rig")
	commands, _ := flags.GetStringArray("command")
	switch {
	case schedule == "":
		return nil, fmt.Errorf("--schedule is required")
	case rawRig == "":
		return nil, fmt.Errorf("--rig is required; use --file for a new rig per job run")
	case len(commands) == 0:
		return nil, fmt.Errorf("at least one --command is required")
	}
	rig, err := rigref.Parse(rawRig)
	if err != nil {
		return nil, err
	}
	timeout, err := durationMS(flags.GetDuration("timeout"))
	if err != nil {
		return nil, fmt.Errorf("--timeout: %w", err)
	}
	var queueTimeout int64
	if flags.Changed("queue-timeout") {
		if queueTimeout, err = durationMS(flags.GetDuration("queue-timeout")); err != nil {
			return nil, fmt.Errorf("--queue-timeout: %w", err)
		}
	}
	session, _ := flags.GetString("session")
	cwd, _ := flags.GetString("cwd")

	steps := make([]apiclient.JobStep, len(commands))
	for i, command := range commands {
		steps[i] = apiclient.JobStep{
			Command:        command,
			TimeoutMS:      timeout,
			QueueTimeoutMS: queueTimeout,
			Session:        session,
			CWD:            cwd,
		}
	}
	sel := rig.Selector()
	switch sel.By {
	case apiclient.SelectByName:
		steps[0].RigName = sel.Value
	case apiclient.SelectByID:
		steps[0].RigID = sel.Value
	default:
		steps[0].RigRef = sel.Value
	}

	timezone, _ := flags.GetString("timezone")
	description, _ := flags.GetString("description")
	finish, _ := flags.GetString("rig-status-on-finish")
	overlap, _ := flags.GetString("overlap-policy")
	req := apiclient.CreateJobRequest{
		Name:              args[0],
		Description:       description,
		Trigger:           apiclient.CronTrigger{Kind: "cron", Schedule: schedule, Timezone: timezone},
		Steps:             steps,
		RigStatusOnFinish: finish,
		OverlapPolicy:     overlap,
	}
	if paused, _ := flags.GetBool("paused"); paused {
		enabled := false
		req.Enabled = &enabled
	}
	return req, nil
}

func runJobList(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	enabledOnly, _ := cmd.Flags().GetBool("enabled")
	pausedOnly, _ := cmd.Flags().GetBool("paused")
	if enabledOnly && pausedOnly {
		return fmt.Errorf("--enabled and --paused cannot be combined")
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	query := apiclient.ListJobsQuery{Limit: 100}
	if enabledOnly || pausedOnly {
		query.Enabled = &enabledOnly
	}
	// Every page, so the output is the whole list rather than its first page.
	client := runmode.NewRemoteClient()
	all := apiclient.ListJobsResponse{Items: []apiclient.Job{}}
	for {
		page, err := client.ListJobs(query)
		if err != nil {
			return err
		}
		all.Items = append(all.Items, page.Items...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		query.Cursor = *page.NextCursor
	}

	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), all)
	}
	if len(all.Items) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No jobs found.")
		return nil
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tSTATE\tSCHEDULE\tTIMEZONE\tNEXT RUN\tSTEPS")
	for _, job := range all.Items {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\n", tableCell(job.Name), jobState(job), tableCell(job.Trigger.Schedule), tableCell(job.Trigger.Timezone), orDash(derefString(job.NextRunAt)), len(job.Steps))
	}
	return w.Flush()
}

func runJobGet(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseJobRef(args[0])
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	job, err := runmode.NewRemoteClient().GetJob(sel)
	if err != nil {
		return explainJobRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), job)
	}
	return writeJob(cmd.OutOrStdout(), job)
}

// jobUpdateFlags are the update flags that each change one field, which
// --file replaces.
var jobUpdateFlags = []string{
	"name", "description", "schedule", "timezone", "rig-status-on-finish",
	"overlap-policy",
}

func runJobUpdate(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseJobRef(args[0])
	if err != nil {
		return err
	}
	flags := cmd.Flags()
	var fileBody interface{}
	if file, _ := flags.GetString("file"); file != "" {
		for _, name := range jobUpdateFlags {
			if flags.Changed(name) {
				return fmt.Errorf("--file cannot be combined with --%s", name)
			}
		}
		if fileBody, err = readJSONObject(cmd, file); err != nil {
			return err
		}
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	client := runmode.NewRemoteClient()

	body := fileBody
	if body == nil {
		fields, err := jobUpdateFields(cmd, client, sel)
		if err != nil {
			return err
		}
		body = fields
	}
	job, err := client.UpdateJob(sel, body)
	if err != nil {
		return explainJobRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), job)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Job %q updated\n\n", job.Name)
	return writeJob(cmd.OutOrStdout(), job)
}

// jobUpdateFields builds a PATCH body from the changed flags. An empty
// --description and --rig-status-on-finish none clear their fields.
func jobUpdateFields(cmd *cobra.Command, client *apiclient.Client, sel apiclient.JobSelector) (map[string]interface{}, error) {
	flags := cmd.Flags()
	fields := map[string]interface{}{}
	if flags.Changed("name") {
		fields["name"], _ = flags.GetString("name")
	}
	if flags.Changed("description") {
		if description, _ := flags.GetString("description"); description != "" {
			fields["description"] = description
		} else {
			fields["description"] = nil
		}
	}
	if flags.Changed("rig-status-on-finish") {
		if finish, _ := flags.GetString("rig-status-on-finish"); finish != "none" {
			fields["rig_status_on_finish"] = finish
		} else {
			fields["rig_status_on_finish"] = nil
		}
	}
	if flags.Changed("overlap-policy") {
		fields["overlap_policy"], _ = flags.GetString("overlap-policy")
	}
	if flags.Changed("schedule") || flags.Changed("timezone") {
		schedule, _ := flags.GetString("schedule")
		timezone, _ := flags.GetString("timezone")
		// The API replaces the whole trigger, and an omitted time zone means
		// UTC, so a change to one half keeps the job's other half.
		if !flags.Changed("schedule") || !flags.Changed("timezone") {
			job, err := client.GetJob(sel)
			if err != nil {
				return nil, explainJobRef(sel, err)
			}
			if !flags.Changed("schedule") {
				schedule = job.Trigger.Schedule
			}
			if !flags.Changed("timezone") {
				timezone = job.Trigger.Timezone
			}
		}
		fields["trigger"] = apiclient.CronTrigger{Kind: "cron", Schedule: schedule, Timezone: timezone}
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("nothing to change; pass a flag such as --schedule, or --file")
	}
	return fields, nil
}

func runJobSetEnabled(cmd *cobra.Command, raw string, enabled bool) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseJobRef(raw)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	job, err := runmode.NewRemoteClient().UpdateJob(sel, map[string]bool{"enabled": enabled})
	if err != nil {
		return explainJobRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), job)
	}
	if enabled {
		fmt.Fprintf(cmd.OutOrStdout(), "Job %q resumed; next run at %s\n", job.Name, orDash(derefString(job.NextRunAt)))
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Job %q paused\n", job.Name)
	}
	return nil
}

func runJobDelete(cmd *cobra.Command, args []string) error {
	force, _ := cmd.Flags().GetBool("force")
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sels := make([]apiclient.JobSelector, len(args))
	for i, raw := range args {
		if sels[i], err = parseJobRef(raw); err != nil {
			return err
		}
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	if !force && format.IsJSON() {
		return fmt.Errorf("refusing to prompt for confirmation with --%s %s; pass --force to delete", output.FlagName, format)
	}
	if !force {
		confirmed, err := cliprompt.Confirm(
			fmt.Sprintf("Delete job(s) %s and their job runs?", strings.Join(args, ", ")),
			bufio.NewReader(cmd.InOrStdin()),
		)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Fprintln(cmd.OutOrStdout(), "Aborted.")
			return nil
		}
	}

	client := runmode.NewRemoteClient()
	pw := format.Progress(cmd.OutOrStdout())
	var errs []string
	results := []output.ItemResult{}
	for i, sel := range sels {
		ref := args[i]
		if err := explainJobRef(sel, client.DeleteJob(sel)); err != nil {
			errs = append(errs, fmt.Sprintf("job %q: %v", ref, err))
			results = append(results, output.ItemResult{Name: ref, Status: "error", Error: err.Error()})
			continue
		}
		fmt.Fprintf(pw, "Job %q deleted\n", ref)
		results = append(results, output.ItemResult{Name: ref, Status: "deleted"})
	}

	if format.IsJSON() {
		if err := format.JSON(cmd.OutOrStdout(), results); err != nil {
			return err
		}
		if len(errs) > 0 {
			return fmt.Errorf("%d of %d failed; see JSON output", len(errs), len(results))
		}
		return nil
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "\n"))
	}
	return nil
}

func runJobRun(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	sel, err := parseJobRef(args[0])
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	key, _ := cmd.Flags().GetString("idempotency-key")
	run, err := runmode.NewRemoteClient().CreateJobRun(sel, key)
	if err != nil {
		return explainJobRef(sel, err)
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), run)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Job run %s started\n\n", run.ID)
	return writeJobRun(cmd.OutOrStdout(), run)
}

func runJobRunsList(cmd *cobra.Command, _ []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	flags := cmd.Flags()
	var query apiclient.ListJobRunsQuery
	if raw, _ := flags.GetString("job"); flags.Changed("job") {
		if query.Job, err = parseJobRef(raw); err != nil {
			return err
		}
	}
	query.Status, _ = flags.GetString("status")
	query.TriggerKind, _ = flags.GetString("trigger")
	query.Limit, _ = flags.GetInt("limit")
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}

	page, err := runmode.NewRemoteClient().ListJobRuns(query)
	if err != nil {
		return explainJobRef(query.Job, err)
	}
	if page.Items == nil {
		page.Items = []apiclient.JobRun{}
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), page)
	}
	if len(page.Items) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No job runs found.")
		return nil
	}
	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tJOB ID\tSTATUS\tTRIGGER\tSCHEDULED\tSTEP\tRIG")
	for _, run := range page.Items {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", run.ID, run.JobID, run.Status, run.TriggerKind, run.ScheduledAt, jobRunStep(run), tableCell(orDash(derefString(run.RigName))))
	}
	return w.Flush()
}

func runJobRunsGet(cmd *cobra.Command, args []string) error {
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	run, err := runmode.NewRemoteClient().GetJobRun(args[0])
	if err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), run)
	}
	return writeJobRun(cmd.OutOrStdout(), run)
}

// parseJobRef parses a job reference: a name or id, or name=<name> /
// id=<id> / ref=<value> to say which field it matches.
func parseJobRef(raw string) (apiclient.JobSelector, error) {
	sel := apiclient.JobSelector{Value: raw, By: apiclient.SelectByRef}
	if kind, ok := rigref.Prefix(raw); ok {
		sel = apiclient.JobSelector{Value: raw[len(kind)+1:], By: string(kind)}
	}
	if strings.TrimSpace(sel.Value) == "" {
		return apiclient.JobSelector{}, fmt.Errorf("job reference %q is empty", raw)
	}
	return sel, nil
}

// explainJobRef rewrites the API's 409 resource_ref_ambiguous for a job
// named by ref into an error that says how to pick one of the two jobs.
func explainJobRef(sel apiclient.JobSelector, err error) error {
	if err != nil && sel.By == apiclient.SelectByRef && apiclient.IsResourceRefAmbiguous(err) {
		return fmt.Errorf("%q is one job's id and another job's name; use %q or %q", sel.Value, "id="+sel.Value, "name="+sel.Value)
	}
	return err
}

// readJSONObject reads a JSON object from path, or from stdin for "-", and
// returns it unchanged for the request body.
func readJSONObject(cmd *cobra.Command, path string) (json.RawMessage, error) {
	var data []byte
	var err error
	if path == "-" {
		data, err = io.ReadAll(cmd.InOrStdin())
	} else {
		data, err = os.ReadFile(path)
	}
	if err != nil {
		return nil, err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, fmt.Errorf("%s: not a JSON object: %w", path, err)
	}
	return json.RawMessage(data), nil
}

// durationMS converts a duration flag to whole milliseconds, which must be
// at least one.
func durationMS(d time.Duration, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	if d < time.Millisecond {
		return 0, fmt.Errorf("must be at least 1ms, got %s", d)
	}
	return d.Milliseconds(), nil
}

// randomIdempotencyKey returns a fresh key for a create request. A retry of
// the same command gets a new key; pass --idempotency-key to make a retry
// return the job the first attempt created.
func randomIdempotencyKey() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating idempotency key: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// jobStepSummary holds the step fields the text output shows.
type jobStepSummary struct {
	RigRef        string                 `json:"rig_ref"`
	RigName       string                 `json:"rig_name"`
	RigID         string                 `json:"rig_id"`
	SandboxRef    string                 `json:"sandbox_ref"`
	SandboxName   string                 `json:"sandbox_name"`
	SandboxID     string                 `json:"sandbox_id"`
	RigCreate     *struct{ Name string } `json:"rig_create"`
	SandboxCreate *struct{ Name string } `json:"sandbox_create"`
	Command       string                 `json:"command"`
	TimeoutMS     int64                  `json:"timeout_ms"`
}

// rig names the step's rig for a table cell: "-" for a step that runs on
// step 0's rig, and "new <prefix>-…" for a rig each job run creates.
func (s jobStepSummary) rig() string {
	create := s.RigCreate
	if create == nil {
		create = s.SandboxCreate
	}
	if create != nil {
		return "new " + create.Name + "-…"
	}
	for _, v := range []string{s.RigRef, s.RigName, s.RigID, s.SandboxRef, s.SandboxName, s.SandboxID} {
		if v != "" {
			return v
		}
	}
	return "-"
}

func writeJob(out io.Writer, job *apiclient.Job) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "Name:\t%s\n", tableCell(job.Name))
	fmt.Fprintf(w, "ID:\t%s\n", job.ID)
	fmt.Fprintf(w, "State:\t%s\n", jobState(*job))
	fmt.Fprintf(w, "Schedule:\t%s (%s)\n", tableCell(job.Trigger.Schedule), tableCell(job.Trigger.Timezone))
	fmt.Fprintf(w, "Next run:\t%s\n", orDash(derefString(job.NextRunAt)))
	fmt.Fprintf(w, "Overlap policy:\t%s\n", job.OverlapPolicy)
	fmt.Fprintf(w, "Rig on finish:\t%s\n", orDash(derefString(job.RigStatusOnFinish)))
	fmt.Fprintf(w, "Description:\t%s\n", tableCell(orDash(derefString(job.Description))))
	fmt.Fprintf(w, "Created:\t%s\n", job.CreatedAt)
	fmt.Fprintf(w, "Updated:\t%s\n", job.UpdatedAt)
	fmt.Fprintln(w, "\nSTEP\tRIG\tTIMEOUT\tCOMMAND")
	for i, raw := range job.Steps {
		var step jobStepSummary
		if err := json.Unmarshal(raw, &step); err != nil {
			return fmt.Errorf("parsing step %d: %w", i, err)
		}
		timeout := (time.Duration(step.TimeoutMS) * time.Millisecond).String()
		fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", i, tableCell(step.rig()), timeout, tableCell(firstLine(step.Command)))
	}
	return w.Flush()
}

func writeJobRun(out io.Writer, run *apiclient.JobRun) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintf(w, "ID:\t%s\n", run.ID)
	fmt.Fprintf(w, "Job ID:\t%s\n", run.JobID)
	fmt.Fprintf(w, "Status:\t%s\n", run.Status)
	fmt.Fprintf(w, "Trigger:\t%s\n", run.TriggerKind)
	fmt.Fprintf(w, "Scheduled:\t%s\n", run.ScheduledAt)
	fmt.Fprintf(w, "Step:\t%s\n", jobRunStep(*run))
	fmt.Fprintf(w, "Rig:\t%s\n", tableCell(orDash(derefString(run.RigName))))
	fmt.Fprintf(w, "Command runs:\t%s\n", orDash(strings.Join(run.CommandRunIDs, ", ")))
	fmt.Fprintf(w, "Error:\t%s\n", tableCell(orDash(derefString(run.Error))))
	fmt.Fprintf(w, "Created:\t%s\n", run.CreatedAt)
	fmt.Fprintf(w, "Completed:\t%s\n", orDash(derefString(run.CompletedAt)))
	return w.Flush()
}

// jobState renders whether a job's schedule is running.
func jobState(job apiclient.Job) string {
	if job.Enabled {
		return "enabled"
	}
	return "paused"
}

// jobRunStep renders a job run's step as "<1-based step>/<count>".
func jobRunStep(run apiclient.JobRun) string {
	return fmt.Sprintf("%d/%d", run.CurrentStep+1, run.StepCount)
}

func firstLine(s string) string {
	if line, _, found := strings.Cut(s, "\n"); found {
		return line + " …"
	}
	return s
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func init() {
	rootCmd.AddCommand(jobCmd)
	jobCmd.AddCommand(jobCreateCmd, jobListCmd, jobGetCmd, jobUpdateCmd, jobPauseCmd, jobResumeCmd, jobDeleteCmd, jobRunCmd, jobRunsCmd)
	jobRunsCmd.AddCommand(jobRunsListCmd, jobRunsGetCmd)

	jobCreateCmd.SetUsageTemplate(jobCreateUsageTemplate)

	f := jobCreateCmd.Flags()
	f.String("file", "", "Read the whole CreateJobRequest body from this JSON file (- for stdin)")
	f.String("schedule", "", "Cron schedule: 5 fields (minute hour day-of-month month day-of-week) or @daily etc.")
	f.String("timezone", "", "IANA time zone the schedule is read in (default UTC)")
	f.String("rig", "", "Rig every step runs on: a name or id, or name=<name> / id=<id> to match one field")
	f.StringArray("command", nil, "Shell command of one step; repeat for more steps, run in order")
	f.Duration("timeout", time.Hour, "Maximum run time of each step once it starts")
	f.Duration("queue-timeout", 0, "Maximum wait for each step to start")
	f.String("session", "", "Session (FIFO lane on the rig) the steps run in (default \"default\")")
	f.String("cwd", "", "Working directory of each step, absolute or relative to the rig's agent directory")
	f.String("description", "", "Description of the job")
	f.String("rig-status-on-finish", "", "Rig status once a job run ends: active, stopped, or deleted")
	f.String("overlap-policy", "", "skip (default) or allow a scheduled run while an earlier one is still running")
	f.Bool("paused", false, "Create the job paused")
	f.String("idempotency-key", "", "Key that makes a retry return the job the first attempt created")

	jobListCmd.Flags().Bool("enabled", false, "List only enabled jobs")
	jobListCmd.Flags().Bool("paused", false, "List only paused jobs")

	u := jobUpdateCmd.Flags()
	u.String("file", "", "Read an UpdateJobRequest body from this JSON file (- for stdin)")
	u.String("name", "", "New name")
	u.String("description", "", "New description; empty clears it")
	u.String("schedule", "", "New cron schedule")
	u.String("timezone", "", "New IANA time zone of the schedule")
	u.String("rig-status-on-finish", "", "active, stopped, deleted, or none to clear it")
	u.String("overlap-policy", "", "skip or allow")

	jobDeleteCmd.Flags().BoolP("force", "f", false, "Skip confirmation prompt")

	jobRunCmd.Flags().String("idempotency-key", "", "Key that makes a retry return the job run the first attempt started")

	r := jobRunsListCmd.Flags()
	r.String("job", "", "Only this job's runs: a name or id, or name=<name> / id=<id>")
	r.String("status", "", "Only runs in this status: pending, running, succeeded, failed, or skipped")
	r.String("trigger", "", "Only runs started this way: cron or manual")
	r.Int("limit", 0, "Maximum number of runs, 1 to 100 (default 20)")
}
