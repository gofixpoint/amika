import type { AgentSessions } from "../agent-sessions/types.js";
import { AmikaError } from "../errors.js";
import { API_BASE_PATH } from "../internal/constants.js";
import type { HTTPClient } from "../internal/http.js";
import {
  normalizeRef,
  queryString,
  refPathSegment,
  setRefSelector,
  type NormalizedRef,
} from "../internal/resource-ref.js";
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
  // The rig is the primary resource here, so its selector is the bare `by`.
  // The server defaults an omitted `by` to `ref`, so a plain string sends none.
  const path = (ref: NormalizedRef, suffix = "") => {
    const params = new URLSearchParams();
    setRefSelector(params, "by", ref);
    return `${API_BASE_PATH}/rigs/${refPathSegment(ref)}${suffix}${queryString(params)}`;
  };
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
      await http.doJSON("POST", path(ref, "/start"));
    },
    stop: async (ref) => {
      await http.doJSON("POST", path(ref, "/stop"));
    },
    delete: async (ref) => {
      await http.doJSON("DELETE", path(ref));
    },
    agentSessions,
  };
  return {
    create: async (request) => {
      // A blank id is a failed substitution, not a request for Amika Cloud:
      // sending it would leave the server to guess.
      if (request.hostId !== undefined && !request.hostId.trim()) {
        throw new AmikaError(
          "hostId must not be empty; omit it to run the rig on Amika Cloud",
        );
      }
      return createRigResource(
        remoteRigFromWire(
          (await http.doJSON<Record<string, unknown>>(
            "POST",
            `${API_BASE_PATH}/rigs`,
            createRigRequestToWire(request),
          )) ?? {},
        ),
        transport,
      );
    },
    list: async () =>
      mapArray(
        await http.doJSON("GET", `${API_BASE_PATH}/rigs`),
        remoteRigFromWire,
      ).map((data) => createRigResource(data, transport)),
    get: async (ref) =>
      createRigResource(
        await transport.get(normalizeRef(ref, "rig")),
        transport,
      ),
    handle: (ref) => createRigHandle(ref, transport),
    getAndWait: async (ref, options) =>
      createRigHandle(ref, transport).wait(options),
  };
}
