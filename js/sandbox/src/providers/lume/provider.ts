/** Local macOS VMs, run by Lume on an Apple Silicon Mac. */
import type { SandboxProvider } from "../provider";
import type { LumeConfig } from "./config";
import { lumeCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { AMIKA_HOME } from "./internal/bootstrap";
import { lumeOperations, mapLumeState } from "./internal/operations";

export default function lumeProvider(config: LumeConfig): SandboxProvider {
  return createProvider(config);
}

export async function openLumeAdapter(config: LumeConfig, id: string) {
  return lumeOperations(config).adapter(id);
}

const createProvider = defineProvider(
  lumeCapabilities,
  (config: LumeConfig) => {
    const ops = lumeOperations(config);
    return {
      name: "lume",
      signedUrlTtlSeconds: 0,
      userHomeDir: AMIKA_HOME,
      sandbox: {
        create: (_ctx, input) => ops.create(input),
        delete: ops.remove,
        start: ops.start,
        stop: ops.stop,
        getState: ops.getState,
        mapState: mapLumeState,
      },
      exec: { stdin: true, run: ops.run },
      files: { read: ops.read, write: ops.write },
      listing: { list: ops.list },
    };
  },
);
