/** Shared Smol machine primitives for direct and hostd-backed providers. */
import type { SmolConfig } from "./config";
import type { ProviderDefinition } from "../shared/define-provider";
import { SmolClient } from "./internal/client";
import { mapSmolState, smolOperations } from "./internal/operations";

/** Bind the Smol wire contract to a provider identity and HTTP transport. */
export function smolDefinition(
  config: SmolConfig,
  name: "smol" | "amika-hostd",
  fetcher = fetch,
): ProviderDefinition {
  const ops = operations(config, name, fetcher);
  return {
    name,
    signedUrlTtlSeconds: 0,
    userHomeDir: "/root",
    sandbox: {
      create: (_ctx, input) => ops.create(input),
      delete: ops.remove,
      start: ops.start,
      stop: ops.stop,
      getState: ops.getState,
      mapState: mapSmolState,
    },
    exec: { stdin: true, run: ops.run },
    files: { read: ops.read, write: ops.write },
    listing: { list: ops.list },
  };
}

/** Open the same file/exec primitives for callers that provision via an adapter. */
export async function openSmolRuntimeAdapter(
  config: SmolConfig,
  id: string,
  name: "smol" | "amika-hostd",
  fetcher = fetch,
) {
  return operations(config, name, fetcher).adapter(id);
}

function operations(
  config: SmolConfig,
  name: "smol" | "amika-hostd",
  fetcher: typeof fetch,
) {
  return smolOperations(
    config,
    new SmolClient(config, fetcher, name === "smol" ? "smolvm" : name),
    name,
  );
}
