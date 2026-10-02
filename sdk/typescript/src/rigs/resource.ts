import { AmikaError, AmikaWaitError } from "../errors.js";
import type {
  AgentSessions,
  AgentSendRequest,
  AgentSessionStreamHandlers,
} from "../agent-sessions/types.js";
import { bindOperations } from "../internal/resource.js";
import { pollTiming, sleep, withDeadline } from "../internal/polling.js";
import type { RemoteRig } from "./types.js";
import type { Rig, RigHandle } from "./rig.js";

export interface RigTransport {
  get(ref: string, signal?: AbortSignal): Promise<RemoteRig>;
  start(ref: string): Promise<void>;
  stop(ref: string): Promise<void>;
  delete(ref: string): Promise<void>;
  agentSessions: AgentSessions;
}

export function createRigHandle(
  ref: string,
  transport: RigTransport,
  data?: RemoteRig,
): RigHandle {
  if (!ref.trim()) throw new AmikaError("rig name or ID must not be empty");
  let rig: Rig | undefined;
  const target = () => rig?.id || ref;
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
      transport.agentSessions.send({ ...request, rigId: target() }),
    sendStream: (
      request: AgentSendRequest,
      handlers?: AgentSessionStreamHandlers,
    ) =>
      transport.agentSessions.sendStream(
        { ...request, rigId: target() },
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
