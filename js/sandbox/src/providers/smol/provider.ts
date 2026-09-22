/** Local smol machines provider, backed by a separately managed smolvm serve. */
import type { SandboxProvider } from "../provider";
import { SmolClient } from "./internal/client";
import type { SmolConfig } from "./config";
import { smolCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { mapSmolState, smolOperations } from "./internal/operations";

/** Construct the public resource API, with an injectable HTTP transport. */
export default function smolProvider(
  config: SmolConfig,
  fetcher = fetch,
): SandboxProvider {
  return createProvider({ config, fetcher });
}

export async function openSmolAdapter(config: SmolConfig, id: string) {
  return smolOperations(config).adapter(id);
}

const createProvider = defineProvider(
  smolCapabilities,
  ({ config, fetcher }: { config: SmolConfig; fetcher: typeof fetch }) => {
    const ops = smolOperations(config, new SmolClient(config, fetcher));
    return {
      name: "smol",
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
  },
);
