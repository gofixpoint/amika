/**
 * Orble provider (https://orble.tech): Debian VMs ("boxes") driven by the
 * Orble REST API through the small client in `./internal/client.ts`.
 *
 * - A box boots Orble's own image (Debian 13) or one of the account's
 *   snapshots.
 * - Orble logs in as `agent`. Commands and files run as the `amika` rig
 *   user, home `/home/amika`, through `sudo` (`../shared/rig-user.ts`).
 * - `stop` suspends the box and `start` resumes it. Orble also suspends an
 *   idle box, and any command wakes it.
 * - One command runs at most 10 minutes, and keeps the last 64 KiB of each
 *   stream (Orble limits).
 */
import type { OrbleConfig } from "./config";
import { orbleCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { rigUserOps, RIG_USER_HOME } from "../shared/rig-user";
import {
  createOrbleSandbox,
  deleteOrbleSandbox,
  getOrbleSandboxState,
  mapOrbleSandboxState,
  startOrbleSandbox,
  stopOrbleSandbox,
} from "./internal/operations";
import { orbleShell } from "./internal/shell";

export { openOrbleAdapter } from "./internal/adapter";

/** Signed URLs do not apply (no services); the contract needs a value. */
const ORBLE_URL_TTL_S = 3600;

export default defineProvider(orbleCapabilities, (config: OrbleConfig) => {
  const ops = (id: string) => rigUserOps(orbleShell(config, id));
  return {
    name: "orble",
    signedUrlTtlSeconds: ORBLE_URL_TTL_S,
    userHomeDir: RIG_USER_HOME,

    sandbox: {
      create: (ctx, input) => createOrbleSandbox(ctx, config, input),
      delete: (id) => deleteOrbleSandbox(config, id),
      start: (id, interval) => startOrbleSandbox(config, id, interval),
      stop: (id) => stopOrbleSandbox(config, id),
      getState: (id) => getOrbleSandboxState(config, id),
      mapState: mapOrbleSandboxState,
    },

    exec: {
      stdin: true,
      run: (id, command, opts) => ops(id).exec(command, opts),
    },

    files: {
      read: (id, path, opts) => ops(id).readFile(path, opts),
      write: (id, path, content) => ops(id).writeFile(path, content),
    },
  };
});
