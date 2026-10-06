/**
 * Local smol machines on the embedded smolvm engine: the `smolmachines` SDK,
 * running VMs in this process with no `smolvm` binary or server beside it.
 */
import type { SandboxProvider } from "../provider";
import { defineProvider } from "../shared/define-provider";
import { smolvmSdkCapabilities } from "./capabilities";
import type { SmolvmSdkConfig } from "./config";
import { smolMachines, type SmolMachines } from "./internal/client";
import { mapSmolvmSdkState, smolvmSdkOperations } from "./internal/operations";

// The runtime primitives amika-hostd serves its machine API over, routed
// through here so the folder root stays the only public entry.
export {
  smolErrorCode as smolvmSdkErrorCode,
  type SmolMachine,
  type SmolMachines,
} from "./internal/client";
export {
  SmolvmSdkNotFoundError,
  SmolvmSdkUnavailableError,
  SmolvmSdkUnpublishedPortError,
  mapSmolvmSdkState,
  smolvmSdkOperations,
} from "./internal/operations";

/** Construct the public resource API, with an injectable SDK for tests. */
export default function smolvmSdkProvider(
  config: SmolvmSdkConfig,
  machines: SmolMachines = smolMachines,
): SandboxProvider {
  return createProvider({ config, machines });
}

export async function openSmolvmSdkAdapter(
  config: SmolvmSdkConfig,
  id: string,
  machines: SmolMachines = smolMachines,
) {
  return smolvmSdkOperations(config, machines).adapter(id);
}

const createProvider = defineProvider(
  smolvmSdkCapabilities,
  ({
    config,
    machines,
  }: {
    config: SmolvmSdkConfig;
    machines: SmolMachines;
  }) => {
    const ops = smolvmSdkOperations(config, machines);
    return {
      name: "smolvm-sdk",
      signedUrlTtlSeconds: 0,
      userHomeDir: "/root",
      sandbox: {
        create: (_ctx, input) => ops.create(input),
        delete: ops.remove,
        start: ops.start,
        stop: ops.stop,
        getState: ops.getState,
        mapState: mapSmolvmSdkState,
      },
      exec: { stdin: true, run: ops.run },
      files: { read: ops.read, write: ops.write },
      services: { refreshUrls: ops.refreshUrls, syncRoutes: ops.syncRoutes },
      listing: { list: ops.list },
    };
  },
);
