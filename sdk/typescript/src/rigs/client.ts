import type { AgentSessions } from "../agent-sessions/types.js";
import { API_BASE_PATH } from "../internal/constants.js";
import type { HTTPClient } from "../internal/http.js";
import { mapArray } from "../internal/wire.js";
import type { Rigs } from "./rig.js";
import {
  createRigHandle,
  createRigResource,
  type RigTransport,
} from "./resource.js";
import { createRigRequestToWire, remoteRigFromWire } from "./wire.js";

export function createRigs(
  http: HTTPClient,
  agentSessions: AgentSessions,
): Rigs {
  const path = (ref: string) =>
    `${API_BASE_PATH}/rigs/${encodeURIComponent(ref)}`;
  const transport: RigTransport = {
    get: async (ref, signal) =>
      remoteRigFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "GET",
          path(ref),
          undefined,
          { signal },
        )) ?? {},
      ),
    start: async (ref) => {
      await http.doJSON("POST", `${path(ref)}/start`);
    },
    stop: async (ref) => {
      await http.doJSON("POST", `${path(ref)}/stop`);
    },
    delete: async (ref) => {
      await http.doJSON("DELETE", path(ref));
    },
    agentSessions,
  };
  return {
    create: async (request) =>
      createRigResource(
        remoteRigFromWire(
          (await http.doJSON<Record<string, unknown>>(
            "POST",
            `${API_BASE_PATH}/rigs`,
            createRigRequestToWire(request),
          )) ?? {},
        ),
        transport,
      ),
    list: async () =>
      mapArray(
        await http.doJSON("GET", `${API_BASE_PATH}/rigs`),
        remoteRigFromWire,
      ).map((data) => createRigResource(data, transport)),
    get: async (ref) => createRigResource(await transport.get(ref), transport),
    handle: (ref) => createRigHandle(ref, transport),
    getAndWait: async (ref, options) =>
      createRigHandle(ref, transport).wait(options),
  };
}
