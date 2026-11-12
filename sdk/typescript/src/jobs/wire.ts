import {
  type CreateJobRequest,
  type Job,
  type JobRun,
  type JobRunStatus,
  type JobRunTriggerKind,
  type JobStep,
  type JobTrigger,
  type OverlapPolicy,
  type RigStatusOnFinish,
  type UpdateJobRequest,
} from "./types.js";
import type { RigRef } from "../resource-ref.js";
import { normalizeRef, refFieldName } from "../internal/resource-ref.js";
import {
  bool,
  mapArray,
  nullableStr,
  num,
  omitUndefined,
  optionalNum,
  optionalStr,
  str,
  strArray,
} from "../internal/wire.js";
import {
  createRigRequestFromWire,
  createRigRequestToWire,
} from "../rigs/wire.js";

export function createJobRequestToWire(
  r: CreateJobRequest,
): Record<string, unknown> {
  return omitUndefined({
    name: r.name,
    description: r.description,
    trigger: jobTriggerToWire(r.trigger),
    steps: r.steps.map(jobStepToWire),
    rig_status_on_finish: r.rigStatusOnFinish,
    overlap_policy: r.overlapPolicy,
    enabled: r.enabled,
  });
}

/** omitUndefined keeps an explicit null, which clears the field. */
export function updateJobRequestToWire(
  r: UpdateJobRequest,
): Record<string, unknown> {
  return omitUndefined({
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    trigger: r.trigger === undefined ? undefined : jobTriggerToWire(r.trigger),
    steps: r.steps?.map(jobStepToWire),
    rig_status_on_finish: r.rigStatusOnFinish,
    overlap_policy: r.overlapPolicy,
  });
}

function jobTriggerToWire(t: JobTrigger): Record<string, unknown> {
  return omitUndefined({
    kind: t.kind,
    schedule: t.schedule,
    timezone: t.timezone,
  });
}

/**
 * A step's rig goes out as `rig_id`, `rig_name`, or `rig_ref`. Giving both
 * `rig` and `rigCreate` sends both, and the server refuses the step.
 */
function jobStepToWire(s: JobStep): Record<string, unknown> {
  const wire = omitUndefined({
    rig_create:
      s.rigCreate === undefined
        ? undefined
        : createRigRequestToWire(s.rigCreate),
    session: s.session,
    command: s.command,
    timeout_ms: s.timeoutMs,
    queue_timeout_ms: s.queueTimeoutMs,
    cwd: s.cwd,
  });
  if (s.rig !== undefined) {
    const ref = normalizeRef(s.rig, "rig");
    wire[refFieldName("rig", ref)] = ref.value;
  }
  return wire;
}

export function jobFromWire(w: Record<string, unknown>): Job {
  const trigger = (w["trigger"] ?? {}) as Record<string, unknown>;
  return {
    id: str(w["id"]),
    name: str(w["name"]),
    description: nullableStr(w["description"]),
    enabled: bool(w["enabled"]),
    trigger: {
      kind: str(trigger["kind"]) as JobTrigger["kind"],
      schedule: str(trigger["schedule"]),
      timezone: optionalStr(trigger["timezone"]),
    },
    steps: mapArray(w["steps"], jobStepFromWire),
    rigStatusOnFinish: nullableStr(
      w["rig_status_on_finish"],
    ) as RigStatusOnFinish | null,
    overlapPolicy: str(w["overlap_policy"]) as OverlapPolicy,
    nextRunAt: nullableStr(w["next_run_at"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
  };
}

/** Reads either spelling of the rig fields: `rig_*`, or the `sandbox_*` alias. */
function jobStepFromWire(w: Record<string, unknown>): JobStep {
  const create = w["rig_create"] ?? w["sandbox_create"];
  return omitUndefined({
    rig: stepRigFromWire(w),
    rigCreate:
      typeof create === "object" && create !== null
        ? createRigRequestFromWire(create as Record<string, unknown>)
        : undefined,
    session: optionalStr(w["session"]),
    command: str(w["command"]),
    timeoutMs: num(w["timeout_ms"]),
    queueTimeoutMs: optionalNum(w["queue_timeout_ms"]),
    cwd: optionalStr(w["cwd"] ?? w["working_directory"]),
  }) as unknown as JobStep;
}

function stepRigFromWire(w: Record<string, unknown>): RigRef | undefined {
  const ref = optionalStr(w["rig_ref"] ?? w["sandbox_ref"]);
  if (ref !== undefined) return ref;
  const name = optionalStr(w["rig_name"] ?? w["sandbox_name"]);
  if (name !== undefined) return { ref: name, by: "name" };
  const id = optionalStr(w["rig_id"] ?? w["sandbox_id"]);
  if (id !== undefined) return { ref: id, by: "id" };
  return undefined;
}

export function jobRunFromWire(w: Record<string, unknown>): JobRun {
  return {
    id: str(w["id"]),
    jobId: str(w["job_id"]),
    triggerKind: str(w["trigger_kind"]) as JobRunTriggerKind,
    scheduledAt: str(w["scheduled_at"]),
    status: str(w["status"]) as JobRunStatus,
    currentStep: num(w["current_step"]),
    stepCount: num(w["step_count"]),
    commandRunIds: strArray(w["command_run_ids"]),
    finishCommandRunId: nullableStr(w["finish_command_run_id"]),
    error: nullableStr(w["error"]),
    rigId: nullableStr(w["rig_id"]),
    rigName: nullableStr(w["rig_name"]),
    createdAt: str(w["created_at"]),
    updatedAt: str(w["updated_at"]),
    completedAt: nullableStr(w["completed_at"]),
  };
}
