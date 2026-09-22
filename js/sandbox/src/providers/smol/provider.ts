/** Local smol machines provider, backed by a separately managed smolvm serve. */
import type { SmolConfig } from "./config";
import { smolCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { mapSmolState, smolOperations } from "./internal/operations";

export default defineProvider(smolCapabilities, (config: SmolConfig) => {
  const ops = smolOperations(config);
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
});

export async function openSmolAdapter(config: SmolConfig, id: string) {
  return smolOperations(config).adapter(id);
}
