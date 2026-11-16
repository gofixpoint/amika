import type { ResourceRef, RigRef } from "../resource-ref.js";
import type { CreateRigRequest } from "../rigs/types.js";

/**
 * When a job fires: a standard 5-field cron expression (`m h dom mon dow`) or
 * one of `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, read in an
 * IANA time zone. Consecutive fires must be at least 5 minutes apart.
 */
export interface CronTrigger {
  kind: "cron";
  /** The cron expression, e.g. `0 9 * * 1-5`. */
  schedule: string;
  /** IANA time zone the schedule is read in. The server defaults it to `UTC`. */
  timezone?: string;
}

/** A job's trigger. `cron` is the only kind for now. */
export type JobTrigger = CronTrigger;

/** The status a job run leaves its rig in once it ends. */
export type RigStatusOnFinish = "active" | "stopped" | "deleted";

/**
 * Whether a scheduled job run starts while an earlier one of the same job is
 * still pending or running: `skip` records it as skipped, `allow` starts it.
 */
export type OverlapPolicy = "skip" | "allow";

/**
 * One command of a job run, run as a Command Run with `bash -e -o pipefail`.
 * Step 0 names the rig of the whole job run with exactly one of `rig` and
 * `rigCreate`; later steps name none and run on step 0's rig.
 */
export interface JobStep {
  /**
   * An existing rig. A plain string matches its ID or name;
   * `{ ref, by: "id" | "name" }` pins one. Step 0 only.
   */
  rig?: RigRef;
  /**
   * Create a rig for each job run. `name` is required and is a prefix: each
   * job run appends `-<12 hex characters>`, so it is at most 50 characters.
   * Step 0 only.
   */
  rigCreate?: CreateRigRequest & { name: string };
  /** FIFO lane on the rig. The server defaults it to `default`. */
  session?: string;
  /** Shell command to run. */
  command: string;
  /** Maximum run time once the command starts, in milliseconds. */
  timeoutMs: number;
  /** Maximum wait from the step's creation to its start, in milliseconds. */
  queueTimeoutMs?: number;
  /** Working directory: absolute, or relative to the rig's agent directory. */
  cwd?: string;
}

/** Request body for creating a job. */
export interface CreateJobRequest {
  /** Unique in the organization. Letters, digits, `_`, `.`, and `-`. */
  name: string;
  /** Free text shown in lists. */
  description?: string;
  trigger: JobTrigger;
  /** 1 to 20 steps, run in order. A step starts only once the one before it succeeded. */
  steps: JobStep[];
  /** Rig status when the job run ends. Omit to let each step follow the default power policy. */
  rigStatusOnFinish?: RigStatusOnFinish;
  /** The server defaults it to `skip`. */
  overlapPolicy?: OverlapPolicy;
  /** False creates the job paused. The server defaults it to true. */
  enabled?: boolean;
}

/**
 * Changes to a job; omitted fields keep their values. `steps` replaces the
 * whole list. A null `description` or `rigStatusOnFinish` clears it.
 */
export interface UpdateJobRequest {
  name?: string;
  description?: string | null;
  /** False pauses the job; true resumes it at its next future slot. */
  enabled?: boolean;
  trigger?: JobTrigger;
  steps?: JobStep[];
  rigStatusOnFinish?: RigStatusOnFinish | null;
  overlapPolicy?: OverlapPolicy;
}

/** A job, as the /jobs endpoints return it. */
export interface Job {
  /** Resource identifier assigned by the server. */
  id: string;
  name: string;
  description: string | null;
  /** False while the job is paused. */
  enabled: boolean;
  /** The trigger, with the server's default time zone filled in. */
  trigger: JobTrigger;
  steps: JobStep[];
  rigStatusOnFinish: RigStatusOnFinish | null;
  overlapPolicy: OverlapPolicy;
  /** When the next slot comes due; null while the job is paused. */
  nextRunAt: string | null;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
}

/** Options for creating a job or a job run. */
export interface IdempotencyOptions {
  /**
   * A repeated key returns the resource the first request created instead of
   * creating another. Pass the same key when you retry. Omitted, `jobs.create`
   * generates one, and `jobRuns.create` sends none.
   */
  idempotencyKey?: string;
}

/** Filters and paging for listing jobs, which come back ordered by name. */
export interface ListJobsOptions {
  /** True lists only enabled jobs; false lists only paused ones. */
  enabled?: boolean;
  triggerKind?: JobTrigger["kind"];
  /** Page size, 1 to 100. The server defaults it to 50. */
  limit?: number;
  /** `nextCursor` of the previous page. */
  cursor?: string;
}

/** One page of jobs. `nextCursor` is null on the last page. */
export interface ListJobsResponse {
  items: Job[];
  nextCursor: string | null;
}

/** Jobs operations available on AmikaClient. */
export interface Jobs {
  /** Create a job. */
  create(req: CreateJobRequest, options?: IdempotencyOptions): Promise<Job>;

  /** List one page of jobs. */
  list(options?: ListJobsOptions): Promise<ListJobsResponse>;

  /**
   * Read one job. A plain string matches its ID or name;
   * `{ ref, by: "id" | "name" }` pins one.
   */
  get(job: ResourceRef): Promise<Job>;

  /** Change a job (see {@link UpdateJobRequest}). */
  update(job: ResourceRef, req: UpdateJobRequest): Promise<Job>;

  /** Pause a job: it skips its slots until it is resumed. */
  pause(job: ResourceRef): Promise<Job>;

  /** Resume a paused job at its next future slot. */
  resume(job: ResourceRef): Promise<Job>;

  /**
   * Delete a job and its job runs; the Command Runs they created stay. The
   * server refuses with 409 `job_has_active_runs` while a job run is pending
   * or running.
   */
  delete(job: ResourceRef): Promise<void>;
}

export type JobRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/** What started a job run: a scheduled slot, or a `jobRuns.create` call. */
export type JobRunTriggerKind = "cron" | "manual";

/** One execution of a job's steps, as the /job-runs endpoints return it. */
export interface JobRun {
  /** Resource identifier assigned by the server. */
  id: string;
  jobId: string;
  triggerKind: JobRunTriggerKind;
  /** The cron slot, or the request time of a manual run. */
  scheduledAt: string;
  status: JobRunStatus;
  /** Index of the step in progress, or of the step that ended the run. */
  currentStep: number;
  stepCount: number;
  /** One Command Run per step started so far, in step order. */
  commandRunIds: string[];
  /** The Command Run that applied `rigStatusOnFinish` when the last step could not. */
  finishCommandRunId: string | null;
  /** Why the job run was skipped or failed. */
  error: string | null;
  /** The rig step 0 ran on; null before it ran, and once the rig is deleted. */
  rigId: string | null;
  rigName: string | null;
  /** Creation timestamp returned by the server. */
  createdAt: string;
  /** Last-update timestamp returned by the server. */
  updatedAt: string;
  /** When it reached succeeded, failed, or skipped. */
  completedAt: string | null;
}

/** Filters for listing job runs, newest first. */
export interface ListJobRunsOptions {
  /** Only this job's runs (see {@link Jobs.get} for how it matches). */
  job?: ResourceRef;
  status?: JobRunStatus;
  triggerKind?: JobRunTriggerKind;
  /** Page size, 1 to 100. The server defaults it to 20. */
  limit?: number;
  /** Only the latest matching job run of each job, paged with `cursor`. */
  latestPerJob?: boolean;
  /** `nextCursor` of the previous page. Requires `latestPerJob`. */
  cursor?: string;
}

/** Job runs. `nextCursor` is set only with `latestPerJob`, and null on its last page. */
export interface ListJobRunsResponse {
  items: JobRun[];
  nextCursor: string | null;
}

/** Job run operations available on AmikaClient. */
export interface JobRuns {
  /**
   * Start a job run now, outside the schedule. It ignores the job's overlap
   * policy and does not move its next scheduled run.
   */
  create(job: ResourceRef, options?: IdempotencyOptions): Promise<JobRun>;

  /** List job runs, newest first. */
  list(options?: ListJobRunsOptions): Promise<ListJobRunsResponse>;

  /** Read one job run by ID. */
  get(id: string): Promise<JobRun>;
}
