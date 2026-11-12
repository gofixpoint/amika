import { type HTTPClient } from "../internal/http.js";
import {
  type IdempotencyOptions,
  type JobRuns,
  type Jobs,
  type ListJobRunsOptions,
  type ListJobsOptions,
} from "./types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import {
  normalizeRef,
  pathSegment,
  pickRef,
  queryString,
  refFieldName,
  refPathSegment,
  setRefSelector,
} from "../internal/resource-ref.js";
import { mapArray, nullableStr } from "../internal/wire.js";
import type { ResourceRef } from "../resource-ref.js";
import {
  createJobRequestToWire,
  jobFromWire,
  jobRunFromWire,
  updateJobRequestToWire,
} from "./wire.js";

export function createJobs(http: HTTPClient): Jobs {
  const base = `${API_BASE_PATH}/jobs`;
  // `{job}` takes `by`, and the server's default is ref.
  const path = (job: ResourceRef) => {
    const ref = normalizeRef(job, "job");
    const params = new URLSearchParams();
    setRefSelector(params, "by", ref);
    return `${base}/${refPathSegment(ref)}${queryString(params)}`;
  };
  const patch = async (job: ResourceRef, body: Record<string, unknown>) =>
    jobFromWire(
      (await http.doJSON<Record<string, unknown>>("PATCH", path(job), body)) ??
        {},
    );
  return {
    create: async (req, options) =>
      jobFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "POST",
          base,
          createJobRequestToWire(req),
          {
            headers: {
              "Idempotency-Key": options?.idempotencyKey ?? randomKey(),
            },
          },
        )) ?? {},
      ),
    list: async (options?: ListJobsOptions) => {
      const params = new URLSearchParams();
      if (options?.enabled !== undefined)
        params.set("enabled", String(options.enabled));
      if (options?.triggerKind) params.set("trigger_kind", options.triggerKind);
      if (options?.limit !== undefined)
        params.set("limit", String(options.limit));
      if (options?.cursor) params.set("cursor", options.cursor);
      const page = await http.doJSON<Record<string, unknown>>(
        "GET",
        `${base}${queryString(params)}`,
      );
      return {
        items: mapArray(page?.["items"], jobFromWire),
        nextCursor: nullableStr(page?.["next_cursor"]),
      };
    },
    get: async (job) =>
      jobFromWire(
        (await http.doJSON<Record<string, unknown>>("GET", path(job))) ?? {},
      ),
    update: (job, req) => patch(job, updateJobRequestToWire(req)),
    pause: (job) => patch(job, { enabled: false }),
    resume: (job) => patch(job, { enabled: true }),
    delete: async (job) => {
      await http.doJSON("DELETE", path(job));
    },
  };
}

export function createJobRuns(http: HTTPClient): JobRuns {
  const base = `${API_BASE_PATH}/job-runs`;
  return {
    create: async (job: ResourceRef, options?: IdempotencyOptions) => {
      const ref = normalizeRef(job, "job");
      return jobRunFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "POST",
          base,
          { [refFieldName("job", ref)]: ref.value },
          options?.idempotencyKey === undefined
            ? undefined
            : { headers: { "Idempotency-Key": options.idempotencyKey } },
        )) ?? {},
      );
    },
    list: async (options?: ListJobRunsOptions) => {
      const params = new URLSearchParams();
      const job = pickRef("job", options?.job);
      if (job) params.set(refFieldName("job", job), job.value);
      if (options?.status) params.set("status", options.status);
      if (options?.triggerKind) params.set("trigger_kind", options.triggerKind);
      if (options?.limit !== undefined)
        params.set("limit", String(options.limit));
      if (options?.latestPerJob !== undefined)
        params.set("latest_per_job", String(options.latestPerJob));
      if (options?.cursor) params.set("cursor", options.cursor);
      const page = await http.doJSON<Record<string, unknown>>(
        "GET",
        `${base}${queryString(params)}`,
      );
      return {
        items: mapArray(page?.["items"], jobRunFromWire),
        nextCursor: nullableStr(page?.["next_cursor"]),
      };
    },
    get: async (id) =>
      jobRunFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "GET",
          `${base}/${pathSegment(id, "job run id")}`,
        )) ?? {},
      ),
  };
}

/**
 * A fresh idempotency key. `crypto.randomUUID` is global from Node 19; the
 * fallback covers Node 18, where uniqueness, not secrecy, is what counts.
 */
function randomKey(): string {
  const uuid = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto?.randomUUID?.();
  if (uuid) return uuid;
  const hex = () => Math.random().toString(16).slice(2);
  return `${Date.now().toString(16)}-${hex()}${hex()}`;
}
