/**
 * The `simulate` provider: a sandbox provider with no vendor behind it.
 *
 * Every sandbox is an in-memory record in a {@link SimulateWorld}. The
 * provider backs the full contract (lifecycle, exec, files, ssh, services,
 * listing, snapshots), so a control plane can run its create, start, stop,
 * snapshot, and metering paths end to end with no cloud account and no
 * network. Tests reach the same world through {@link getSimulateWorld} to
 * script command output, inject faults, make a sandbox vanish, or move the
 * clock.
 */
import { DEFAULT_HOME_DIR } from "../../constants";
import type { SimulateConfig } from "./config";
import { simulateCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import {
  captureSimulateSnapshot,
  createSimulateImageSnapshot,
  createSimulateSandbox,
  deleteSimulateSandbox,
  deleteSimulateSnapshot,
  executeSimulateCommand,
  getSimulateSandboxState,
  getSimulateSnapshot,
  isSimulateEnvScrubbable,
  listSimulateSandboxes,
  mapSimulateState,
  mintSimulateSsh,
  readSimulateFile,
  refreshSimulateUrls,
  revokeSimulateSsh,
  SIMULATE_URL_TTL_S,
  simulateWorldFor,
  startSimulateSandbox,
  stopSimulateSandbox,
  streamSimulateCommand,
  syncSimulateRoutes,
  waitForSimulateSnapshotActive,
  writeSimulateFile,
} from "./internal/operations";

export { openSimulateAdapter } from "./internal/operations";
// The world is the provider's control surface: the control plane and tests
// drive scenarios through it, so it is public alongside the provider.
export {
  getSimulateWorld,
  resetSimulateWorlds,
  SimulateFaultError,
  SimulateNotFoundError,
  SimulateWorld,
  DEFAULT_SIMULATE_RESOURCES,
  type SimulateExecCall,
  type SimulateExecHandler,
  type SimulateOperation,
  type SimulateSnapshot,
  type SimulateVm,
  type SimulateVmState,
} from "./internal/world";

export default defineProvider(
  simulateCapabilities,
  (config: SimulateConfig) => {
    const world = simulateWorldFor(config);
    return {
      name: "simulate",
      signedUrlTtlSeconds: SIMULATE_URL_TTL_S,
      userHomeDir: DEFAULT_HOME_DIR,
      sandbox: {
        create: (_ctx, input) => createSimulateSandbox(world, input),
        delete: (id) => deleteSimulateSandbox(world, id),
        start: (id, interval) => startSimulateSandbox(world, id, interval),
        stop: (id) => stopSimulateSandbox(world, id),
        getState: (id) => getSimulateSandboxState(world, id),
        mapState: mapSimulateState,
      },
      exec: {
        stdin: true,
        run: (id, command, opts) =>
          executeSimulateCommand(world, id, command, opts),
        stream: (id, command, handlers) =>
          streamSimulateCommand(world, id, command, handlers),
      },
      files: {
        read: (id, path, opts) => readSimulateFile(world, id, path, opts),
        write: (id, path, content) =>
          writeSimulateFile(world, id, path, content),
      },
      ssh: {
        mint: (id, expiresInMinutes) =>
          mintSimulateSsh(world, id, expiresInMinutes),
        revoke: (_id, token) => revokeSimulateSsh(world, token),
      },
      services: {
        refreshUrls: (id, services) => refreshSimulateUrls(world, id, services),
        syncRoutes: (id, desired) => syncSimulateRoutes(world, id, desired),
      },
      listing: { list: () => listSimulateSandboxes(world) },
      snapshots: {
        createImageSnapshot: (input) =>
          createSimulateImageSnapshot(world, input),
        getSnapshot: (name) => getSimulateSnapshot(world, name),
        deleteSnapshot: (name) => deleteSimulateSnapshot(world, name),
        waitForSnapshotActive: (name) =>
          waitForSimulateSnapshotActive(world, name),
        capture: (id, name, opts) =>
          captureSimulateSnapshot(world, id, name, opts),
        isEnvScrubbable: (id) => isSimulateEnvScrubbable(world, id),
      },
    };
  },
);
