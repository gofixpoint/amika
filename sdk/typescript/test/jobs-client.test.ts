import { describe, it, expect } from "vitest";
import { AmikaClient, AmikaError } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

const jobWire = {
  id: "job_1",
  name: "nightly",
  description: null,
  enabled: true,
  trigger: { kind: "cron", schedule: "0 9 * * 1-5", timezone: "UTC" },
  steps: [
    {
      rig_create: {
        name: "nightly",
        repo_url: "https://github.com/org/repo",
        env_vars: {},
        snapshot: null,
      },
      command: "pnpm install",
      timeout_ms: 600000,
    },
    { command: "pnpm audit", timeout_ms: 60000, session: "jobs", cwd: "app" },
  ],
  rig_status_on_finish: "deleted",
  overlap_policy: "skip",
  next_run_at: "2026-11-13T09:00:00Z",
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
};

const jobRunWire = {
  id: "jr_1",
  job_id: "job_1",
  trigger_kind: "manual",
  scheduled_at: "2026-11-12T10:00:00Z",
  status: "pending",
  current_step: 0,
  step_count: 2,
  command_run_ids: [],
  finish_command_run_id: null,
  error: null,
  rig_id: null,
  rig_name: null,
  created_at: "2026-11-12T10:00:00Z",
  updated_at: "2026-11-12T10:00:00Z",
  completed_at: null,
};

describe("client.jobs", () => {
  it("create POSTs the snake_case body with an Idempotency-Key", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: jobWire }]);
    const job = await makeClient(fetch).jobs.create(
      {
        name: "nightly",
        trigger: { kind: "cron", schedule: "0 9 * * 1-5" },
        steps: [
          {
            rig: { ref: "dev", by: "name" },
            command: "pnpm install",
            timeoutMs: 600000,
            queueTimeoutMs: 1000,
          },
          { command: "pnpm audit", timeoutMs: 60000 },
        ],
        rigStatusOnFinish: "stopped",
        overlapPolicy: "allow",
        enabled: false,
      },
      { idempotencyKey: "key-1" },
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/jobs`);
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "nightly",
      trigger: { kind: "cron", schedule: "0 9 * * 1-5" },
      steps: [
        {
          rig_name: "dev",
          command: "pnpm install",
          timeout_ms: 600000,
          queue_timeout_ms: 1000,
        },
        { command: "pnpm audit", timeout_ms: 60000 },
      ],
      rig_status_on_finish: "stopped",
      overlap_policy: "allow",
      enabled: false,
    });
    expect(job.id).toBe("job_1");
  });

  it("create generates an Idempotency-Key when none is given", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: jobWire }]);
    await makeClient(fetch).jobs.create({
      name: "nightly",
      trigger: { kind: "cron", schedule: "@daily" },
      steps: [{ rig: "dev", command: "true", timeoutMs: 1000 }],
    });
    expect(calls[0]?.headers["Idempotency-Key"]).toMatch(/\S{8,}/);
    expect(JSON.parse(calls[0]?.body ?? "").steps[0].rig_ref).toBe("dev");
  });

  it("create maps rigCreate onto rig_create", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: jobWire }]);
    await makeClient(fetch).jobs.create({
      name: "nightly",
      trigger: { kind: "cron", schedule: "@daily" },
      steps: [
        {
          rigCreate: { name: "nightly", repoUrl: "https://github.com/o/r" },
          command: "true",
          timeoutMs: 1000,
        },
      ],
    });
    expect(JSON.parse(calls[0]?.body ?? "").steps[0].rig_create).toEqual({
      name: "nightly",
      repo_url: "https://github.com/o/r",
    });
  });

  it("decodes a job, its trigger, and its steps", async () => {
    const { fetch } = mockFetch([{ status: 200, body: jobWire }]);
    const job = await makeClient(fetch).jobs.get("nightly");
    expect(job).toEqual({
      id: "job_1",
      name: "nightly",
      description: null,
      enabled: true,
      trigger: { kind: "cron", schedule: "0 9 * * 1-5", timezone: "UTC" },
      steps: [
        {
          rigCreate: {
            name: "nightly",
            repoUrl: "https://github.com/org/repo",
            envVars: {},
            snapshot: null,
          },
          command: "pnpm install",
          timeoutMs: 600000,
        },
        {
          command: "pnpm audit",
          timeoutMs: 60000,
          session: "jobs",
          cwd: "app",
        },
      ],
      rigStatusOnFinish: "deleted",
      overlapPolicy: "skip",
      nextRunAt: "2026-11-13T09:00:00Z",
      createdAt: "2026-11-12T00:00:00Z",
      updatedAt: "2026-11-12T00:00:00Z",
    });
  });

  it("decodes a step's rig selector in either spelling", async () => {
    const steps = [
      { rig_name: "a", command: "x", timeout_ms: 1 },
      { sandbox_id: "b", command: "x", timeout_ms: 1 },
      { rig_ref: "c", command: "x", timeout_ms: 1 },
    ];
    const { fetch } = mockFetch([{ status: 200, body: { ...jobWire, steps } }]);
    const job = await makeClient(fetch).jobs.get("nightly");
    expect(job.steps.map((s) => s.rig)).toEqual([
      { ref: "a", by: "name" },
      { ref: "b", by: "id" },
      "c",
    ]);
  });

  it("get sends a pinned kind as by and a plain string as is", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: jobWire },
      { status: 200, body: jobWire },
    ]);
    const client = makeClient(fetch);
    await client.jobs.get("nightly");
    await client.jobs.get({ ref: "job_1", by: "id" });
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/jobs/nightly`);
    expect(calls[1]?.url).toBe(`${BASE}/api/v0beta1/jobs/job_1?by=id`);
  });

  it("rejects an empty job reference before any request", async () => {
    const { fetch, calls } = mockFetch([]);
    await expect(makeClient(fetch).jobs.get(" ")).rejects.toBeInstanceOf(
      AmikaError,
    );
    expect(calls).toHaveLength(0);
  });

  it("list sends its filters and decodes the page", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [jobWire], next_cursor: "c2" } },
    ]);
    const page = await makeClient(fetch).jobs.list({
      enabled: false,
      triggerKind: "cron",
      limit: 10,
      cursor: "c1",
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/jobs?enabled=false&trigger_kind=cron&limit=10&cursor=c1`,
    );
    expect(page.items[0]?.name).toBe("nightly");
    expect(page.nextCursor).toBe("c2");
  });

  it("update PATCHes only the given fields, keeping a null", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: jobWire }]);
    await makeClient(fetch).jobs.update("nightly", {
      description: null,
      rigStatusOnFinish: null,
      trigger: { kind: "cron", schedule: "@hourly", timezone: "Europe/Warsaw" },
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      description: null,
      rig_status_on_finish: null,
      trigger: { kind: "cron", schedule: "@hourly", timezone: "Europe/Warsaw" },
    });
  });

  it("pause and resume PATCH enabled", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: jobWire },
      { status: 200, body: jobWire },
    ]);
    const client = makeClient(fetch);
    await client.jobs.pause("nightly");
    await client.jobs.resume({ ref: "nightly", by: "name" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ enabled: false });
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ enabled: true });
    expect(calls[1]?.url).toBe(`${BASE}/api/v0beta1/jobs/nightly?by=name`);
  });

  it("delete sends DELETE", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    await makeClient(fetch).jobs.delete("nightly");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/jobs/nightly`);
  });
});

describe("client.jobRuns", () => {
  it("create names the job in the field its kind calls for", async () => {
    const { fetch, calls } = mockFetch([
      { status: 201, body: jobRunWire },
      { status: 201, body: jobRunWire },
    ]);
    const client = makeClient(fetch);
    const run = await client.jobRuns.create("nightly");
    await client.jobRuns.create(
      { ref: "job_1", by: "id" },
      { idempotencyKey: "k" },
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ job_ref: "nightly" });
    expect(calls[0]?.headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ job_id: "job_1" });
    expect(calls[1]?.headers["Idempotency-Key"]).toBe("k");
    expect(run).toEqual({
      id: "jr_1",
      jobId: "job_1",
      triggerKind: "manual",
      scheduledAt: "2026-11-12T10:00:00Z",
      status: "pending",
      currentStep: 0,
      stepCount: 2,
      commandRunIds: [],
      finishCommandRunId: null,
      error: null,
      rigId: null,
      rigName: null,
      createdAt: "2026-11-12T10:00:00Z",
      updatedAt: "2026-11-12T10:00:00Z",
      completedAt: null,
    });
  });

  it("list sends its filters", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [jobRunWire], next_cursor: null } },
    ]);
    const page = await makeClient(fetch).jobRuns.list({
      job: { ref: "nightly", by: "name" },
      status: "failed",
      triggerKind: "cron",
      limit: 5,
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/job-runs?job_name=nightly&status=failed&trigger_kind=cron&limit=5`,
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("get reads one job run by id", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: jobRunWire }]);
    await makeClient(fetch).jobRuns.get("jr_1");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/job-runs/jr_1`);
  });
});
