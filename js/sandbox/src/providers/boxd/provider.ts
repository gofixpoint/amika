/**
 * boxd provider (https://boxd.sh): Ubuntu microVMs ("machines") driven by
 * boxd's gRPC API through its SDK (`./internal/client.ts`).
 *
 * - A machine boots boxd's default image (Ubuntu 24.04) or another image
 *   boxd offers.
 * - boxd logs in as `boxd`. Commands and files run as the `amika` rig user,
 *   home `/home/amika`, through `sudo` (`../shared/rig-user.ts`).
 * - `stop` powers the machine off; its disk stays.
 */
import type { BoxdConfig } from "./config";
import { boxdCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { rigUserOps, RIG_USER_HOME } from "../shared/rig-user";
import {
  createBoxdSandbox,
  deleteBoxdSandbox,
  getBoxdSandboxState,
  listBoxdSandboxes,
  listBoxdSizes,
  mapBoxdSandboxState,
  startBoxdSandbox,
  stopBoxdSandbox,
} from "./internal/operations";
import { boxdShell } from "./internal/shell";

export { openBoxdAdapter } from "./internal/adapter";

/** Signed URLs do not apply (no services); the contract needs a value. */
const BOXD_URL_TTL_S = 3600;

export default defineProvider(boxdCapabilities, (config: BoxdConfig) => {
  const ops = (id: string) => rigUserOps(boxdShell(config, id));
  return {
    name: "boxd",
    signedUrlTtlSeconds: BOXD_URL_TTL_S,
    userHomeDir: RIG_USER_HOME,

    sandbox: {
      create: (ctx, input) => createBoxdSandbox(ctx, config, input),
      delete: (id) => deleteBoxdSandbox(config, id),
      start: (id, interval) => startBoxdSandbox(config, id, interval),
      stop: (id) => stopBoxdSandbox(config, id),
      getState: (id) => getBoxdSandboxState(config, id),
      mapState: mapBoxdSandboxState,
    },

    exec: {
      stdin: true,
      run: (id, command, opts) => ops(id).exec(command, opts),
      stream: (id, command, handlers) => ops(id).stream(command, handlers),
    },

    files: {
      read: (id, path, opts) => ops(id).readFile(path, opts),
      write: (id, path, content) => ops(id).writeFile(path, content),
    },

    listing: { list: () => listBoxdSandboxes(config) },

    account: { listSizes: () => listBoxdSizes(config) },
  };
});
