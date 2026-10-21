import { API_BASE_PATH } from "../internal/constants.js";
import type { HTTPClient } from "../internal/http.js";
import {
  idRef,
  normalizeRef,
  pickRef,
  refFieldName,
  nonBlank,
  refPathSegment,
  setRefSelector,
  type NormalizedRef,
} from "../internal/resource-ref.js";
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
  // The server defaults an omitted snapshot `by` to name, so a plain string
  // sends by=ref explicitly to keep its ID-or-name meaning.
  const path = (ref: NormalizedRef) => {
    const params = new URLSearchParams();
    setRefSelector(params, "by", ref, "ref");
    return `${base}/${refPathSegment(ref)}?${params}`;
  };
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
      // An empty deprecated alias keeps its old meaning in a filter: none.
      const source = pickRef(
        "sourceRig",
        options?.sourceRig,
        idRef(nonBlank(options?.sourceRigId)),
        idRef(nonBlank(options?.sourceSandboxId)),
      );
      if (source)
        params.set(refFieldName("source_sandbox", source), source.value);
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
      createSnapshotResource(
        await transport.get(normalizeRef(ref, "snapshot")),
        transport,
      ),
    handle: (ref) => createSnapshotHandle(ref, transport),
    previewScrub: async (rig) => {
      const ref = normalizeRef(rig, "rig");
      const params = new URLSearchParams({ sandbox: ref.value });
      // The rig is the endpoint's only resource reference, so it takes the
      // bare `by`. An omitted `by` means name here, so send ref explicitly.
      setRefSelector(params, "by", ref, "ref");
      return rigScrubPreviewFromWire(
        (await http.doJSON<Record<string, unknown>>(
          "GET",
          `${base}/scrub-preview?${params}`,
        )) ?? {},
      );
    },
  };
}
