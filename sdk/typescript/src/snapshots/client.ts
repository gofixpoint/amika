import { API_BASE_PATH } from "../internal/constants.js";
import type { HTTPClient } from "../internal/http.js";
import { mapArray } from "../internal/wire.js";
import type { Snapshots } from "./snapshot.js";
import {
  createSnapshotHandle,
  createSnapshotResource,
  type SnapshotTransport,
} from "./resource.js";
import {
  createRigSnapshotRequestToWire,
  rigSnapshotFromWire,
  rigScrubPreviewFromWire,
} from "./wire.js";

export function createSnapshots(http: HTTPClient): Snapshots {
  const base = `${API_BASE_PATH}/rig-snapshots`;
  const path = (ref: string) => `${base}/${encodeURIComponent(ref)}?by=ref`;
  const transport: SnapshotTransport = {
    get: async (ref, signal) =>
      rigSnapshotFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "GET",
          path(ref),
          undefined,
          { signal },
        )) ?? {},
      ),
    delete: async (ref) => {
      await http.doJSON("DELETE", path(ref));
    },
  };
  return {
    create: async (request) =>
      createSnapshotResource(
        rigSnapshotFromWire(
          (await http.doJSON<Record<string, unknown>>(
            "POST",
            base,
            createRigSnapshotRequestToWire(request),
          )) ?? {},
        ),
        transport,
      ),
    list: async (options) => {
      const params = new URLSearchParams();
      if (options?.repositoryId)
        params.set("repository_id", options.repositoryId);
      const source = options?.sourceRigId || options?.sourceSandboxId;
      if (source) params.set("source_sandbox_id", source);
      const query = params.toString();
      const envelope = await http.doJSON<{ items?: unknown[] }>(
        "GET",
        `${base}${query ? `?${query}` : ""}`,
      );
      return mapArray(envelope?.items, rigSnapshotFromWire).map((data) =>
        createSnapshotResource(data, transport),
      );
    },
    get: async (ref) =>
      createSnapshotResource(await transport.get(ref), transport),
    handle: (ref) => createSnapshotHandle(ref, transport),
    previewScrub: async (rigRef) => {
      const params = new URLSearchParams({ sandbox: rigRef, by: "ref" });
      return rigScrubPreviewFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "GET",
          `${base}/scrub-preview?${params}`,
        )) ?? {},
      );
    },
  };
}
