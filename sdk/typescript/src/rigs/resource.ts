import { AmikaError, AmikaWaitError } from "../errors.js";
import type {
  AgentSessions,
  AgentSendRequest,
  AgentSessionStreamHandlers,
} from "../agent-sessions/types.js";
import { bindOperations } from "../internal/resource.js";
import { pollTiming, sleep, withDeadline } from "../internal/polling.js";
import { normalizeRef, type NormalizedRef } from "../internal/resource-ref.js";
import type { RigRef } from "../resource-ref.js";
import type { RemoteRig } from "./types.js";
import type { Rig, RigHandle } from "./rig.js";

export interface RigTransport {
  get(ref: NormalizedRef, signal?: AbortSignal): Promise<RemoteRig>;
  start(ref: NormalizedRef): Promise<void>;
  stop(ref: NormalizedRef): Promise<void>;
  delete(ref: NormalizedRef): Promise<void>;
  agentSessions: AgentSessions;
}

export function createRigHandle(
  given: RigRef,
  transport: RigTransport,
  data?: RemoteRig,
): RigHandle {
  const initial = normalizeRef(given, "rig");
  const ref = initial.value;
  let rig: Rig | undefined;
  // Once the rig has been fetched, pin its ID so a later rename (or another
  // rig taking this name) cannot change the target. Before that, the caller's
  // reference goes out exactly as given.
  const target = (): NormalizedRef =>
    rig?.id ? { value: rig.id, kind: "id", pinned: true } : initial;
  const targetRef = (): RigRef => {
    const t = target();
    return t.pinned ? { ref: t.value, by: t.kind } : t.value;
  };
  const update = (latest: RemoteRig): Rig => {
    if (rig) Object.assign(rig, latest);
    else
      rig = bindOperations(latest, {
        ...operations,
        refresh: operations.fetch,
      });
    return rig;
  };
  const operations: RigHandle = {
    fetch: async () => update(await transport.get(target())),
    wait: async (options = {}) => {
      const statuses =
        typeof options.status === "string"
          ? [options.status]
          : [...(options.status ?? ["running"])];
      if (
        !statuses.length ||
        statuses.some((s) => !["running", "stopped", "suspended"].includes(s))
      ) {
        throw new AmikaError(
          "wait: status must contain running, stopped, or suspended",
        );
      }
      if (options.setupStatus !== undefined && options.setupStatus !== "ok")
        throw new AmikaError('wait: setupStatus must be "ok"');
      const setupStatus =
        options.setupStatus ??
        (statuses.includes("running") ? "ok" : undefined);
      const { pollMs, maxWaitMs } = pollTiming(options);
      return withDeadline(
        maxWaitMs,
        async (signal) => {
          for (;;) {
            const latest = await transport.get(target(), signal);
            signal.throwIfAborted();
            const current = update(latest);
            if (current.state === "failed" || current.status === "failed") {
              throw new AmikaWaitError(
                "provisioning",
                current.errorMessage ||
                  `Rig ${ref} failed while waiting for ${statuses.join(" or ")}`,
                current,
              );
            }
            if (
              setupStatus &&
              ["setup-failed", "git-failed", "sys-setup-failed"].includes(
                current.setupStatus ?? "",
              )
            ) {
              throw new AmikaWaitError(
                "setup",
                current.errorMessage ||
                  `Rig ${ref} setup failed: ${current.setupStatus}`,
                current,
              );
            }
            if (
              statuses.some(
                (s) =>
                  s === current.status ||
                  (s === "stopped" && current.status === "suspended"),
              ) &&
              (!setupStatus || current.setupStatus === setupStatus)
            )
              return current;
            await sleep(pollMs, signal);
          }
        },
        () =>
          new AmikaWaitError(
            "timeout",
            `Timed out after ${maxWaitMs}ms waiting for rig ${ref} (status: ${rig?.status ?? "unknown"}, setup: ${rig?.setupStatus ?? "unknown"})`,
            rig ?? { id: "", state: "", status: "" },
          ),
      );
    },
    start: () => transport.start(target()),
    stop: () => transport.stop(target()),
    delete: () => transport.delete(target()),
    send: (request: AgentSendRequest) =>
      transport.agentSessions.send({ ...request, rig: targetRef() }),
    sendStream: (
      request: AgentSendRequest,
      handlers?: AgentSessionStreamHandlers,
    ) =>
      transport.agentSessions.sendStream(
        { ...request, rig: targetRef() },
        handlers,
      ),
  };
  if (data) return update(data);
  // Methods are also non-enumerable on unchecked handles.
  return bindOperations({}, operations);
}

export function createRigResource(
  data: RemoteRig,
  transport: RigTransport,
): Rig {
  return createRigHandle(data.id || data.name, transport, data) as Rig;
}
