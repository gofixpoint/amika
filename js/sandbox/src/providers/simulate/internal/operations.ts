/**
 * The `simulate` provider's capability primitives, each one a world
 * transition run through the world's fault and latency gate.
 */
import type { SandboxService } from "../../../types";
import type { SandboxStatus } from "../../../sandbox-status";
import type {
  CreateImageSnapshotInput,
  CreateSandboxProviderInput,
  CreatedProviderSandbox,
  CapturedSnapshot,
  ExecCommandOptions,
  MintedSshAccess,
  ProviderSandboxListing,
  ProviderSnapshot,
  RefreshUrlsResult,
  ReadFileBytesOptions,
  SandboxExecResult,
  StreamCommandHandlers,
} from "../../provider";
import type {
  ExecOptions,
  ExecResult,
  SandboxAdapter,
} from "../../shared/adapter";
import { decodeUtf8 } from "../../shared/adapter";
import {
  getSimulateWorld,
  SimulateNotFoundError,
  type SimulateSnapshot,
  type SimulateWorld,
} from "./world";
import type { SimulateConfig } from "../config";

/**
 * Hostname suffix for the URLs and SSH destinations the provider mints.
 * `.invalid` is reserved (RFC 2606) and never resolves, so a test that leaks
 * one of these addresses cannot reach a real host.
 */
export const SIMULATE_HOST_SUFFIX = "sim.invalid";

export const SIMULATE_URL_TTL_S = 60 * 60;

/** The world the provider built from `config` operates on. */
export function simulateWorldFor(config: SimulateConfig): SimulateWorld {
  return getSimulateWorld(config.worldId);
}

export function mapSimulateState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

export function createSimulateSandbox(
  world: SimulateWorld,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  return world.perform("create", () => {
    const vm = world.createVm(input);
    return {
      provider: "simulate",
      providerSandboxId: vm.id,
      services: input.services,
      envVars: vm.envVars,
    };
  });
}

export function deleteSimulateSandbox(
  world: SimulateWorld,
  id: string,
): Promise<void> {
  return world.perform("delete", () => world.deleteVm(id));
}

export function startSimulateSandbox(
  world: SimulateWorld,
  id: string,
  autoStopInterval?: number | null,
): Promise<void> {
  return world.perform("start", () => world.startVm(id, autoStopInterval));
}

export function stopSimulateSandbox(
  world: SimulateWorld,
  id: string,
): Promise<void> {
  return world.perform("stop", () => world.stopVm(id));
}

export function getSimulateSandboxState(
  world: SimulateWorld,
  id: string,
): Promise<string> {
  return world.perform("getState", () => world.requireVm(id).state);
}

export function executeSimulateCommand(
  world: SimulateWorld,
  id: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  return world.perform("exec", () => world.exec(id, command, opts));
}

/** Run the command, then hand its output to the handlers in one chunk each. */
export async function streamSimulateCommand(
  world: SimulateWorld,
  id: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  const result = await executeSimulateCommand(world, id, command);
  if (result.stdout) handlers.onStdout(result.stdout);
  if (result.stderr) handlers.onStderr?.(result.stderr);
}

export function readSimulateFile(
  world: SimulateWorld,
  id: string,
  path: string,
  opts?: ReadFileBytesOptions,
): Promise<Uint8Array | null> {
  return world.perform("readFile", () => world.readFile(id, path, opts));
}

export function writeSimulateFile(
  world: SimulateWorld,
  id: string,
  path: string,
  content: Buffer | string,
): Promise<void> {
  return world.perform("writeFile", () => world.writeFile(id, path, content));
}

export function listSimulateSandboxes(
  world: SimulateWorld,
): Promise<ProviderSandboxListing[]> {
  return world.perform("list", () =>
    world.vms().map((vm) => ({
      providerSandboxId: vm.id,
      orgId: vm.orgId,
      state: vm.state,
      sizing: { ...vm.resources },
    })),
  );
}

/**
 * Service URLs are a pure function of the sandbox id and the container port,
 * so a refresh returns the same URL every time and a test can predict it.
 */
export function refreshSimulateUrls(
  world: SimulateWorld,
  id: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  return world.perform("refreshUrls", () => {
    world.requireVm(id);
    return {
      services: services.map((service) => ({
        ...service,
        hostPort: service.containerPort,
        url: `http://${id}-${service.containerPort}.${SIMULATE_HOST_SUFFIX}`,
      })),
    };
  });
}

export function syncSimulateRoutes(
  world: SimulateWorld,
  id: string,
  desired: SandboxService[],
): Promise<void> {
  return world.perform("syncRoutes", () => {
    world.requireVm(id).routes = [...desired];
  });
}

export function mintSimulateSsh(
  world: SimulateWorld,
  id: string,
  expiresInMinutes: number,
): Promise<MintedSshAccess> {
  return world.perform("sshMint", () => ({
    token: world.mintSsh(id),
    sshDestination: `amika@${id}.${SIMULATE_HOST_SUFFIX}`,
    expiresAt: new Date(world.now() + expiresInMinutes * 60_000),
  }));
}

export function revokeSimulateSsh(
  world: SimulateWorld,
  token: string,
): Promise<void> {
  return world.perform("sshRevoke", () => world.revokeSsh(token));
}

export function getSimulateSnapshot(
  world: SimulateWorld,
  name: string,
): Promise<ProviderSnapshot | null> {
  return world.perform("getSnapshot", () => {
    const snapshot = world.snapshot(name);
    return snapshot ? toProviderSnapshot(snapshot) : null;
  });
}

export function deleteSimulateSnapshot(
  world: SimulateWorld,
  name: string,
): Promise<void> {
  return world.perform("deleteSnapshot", () => world.deleteSnapshot(name));
}

/** Simulated snapshots are active as soon as they exist, so this never waits. */
export function waitForSimulateSnapshotActive(
  world: SimulateWorld,
  name: string,
): Promise<ProviderSnapshot> {
  return world.perform("waitForSnapshotActive", () => {
    const snapshot = world.snapshot(name);
    if (!snapshot) throw new SimulateNotFoundError("snapshot", name);
    return toProviderSnapshot(snapshot);
  });
}

export function captureSimulateSnapshot(
  world: SimulateWorld,
  id: string,
  name: string,
  opts: { keepSourceRunning: boolean },
): Promise<CapturedSnapshot> {
  return world.perform("captureSnapshot", () => {
    world.captureSnapshot(id, name, opts.keepSourceRunning);
    // Snapshots are addressed by name (`snapshotIdsAreOpaque: false`).
    return { providerSnapshotId: null };
  });
}

export function createSimulateImageSnapshot(
  world: SimulateWorld,
  input: CreateImageSnapshotInput,
): Promise<ProviderSnapshot | null> {
  return world.perform("createImageSnapshot", () => {
    const snapshot = world.createImageSnapshot(input.name, input.image);
    return snapshot ? toProviderSnapshot(snapshot) : null;
  });
}

export function isSimulateEnvScrubbable(
  world: SimulateWorld,
  id: string,
): Promise<boolean> {
  return Promise.resolve(world.requireVm(id).scrubSafe);
}

/** The provisioning adapter over a simulated sandbox. */
export function openSimulateAdapter(
  config: SimulateConfig,
  id: string,
): Promise<SandboxAdapter> {
  const world = simulateWorldFor(config);
  return Promise.resolve({
    exec: (command: string, opts?: ExecOptions): Promise<ExecResult> =>
      executeSimulateCommand(world, id, command, opts),
    uploadFile: (content: Buffer | string, path: string) =>
      writeSimulateFile(world, id, path, content),
    downloadFile: async (path: string) => {
      const bytes = await readSimulateFile(world, id, path);
      return bytes ? decodeUtf8(bytes) : null;
    },
  });
}

function toProviderSnapshot(snapshot: SimulateSnapshot): ProviderSnapshot {
  return {
    name: snapshot.name,
    providerSnapshotId: null,
    state: snapshot.state,
    imageName: snapshot.imageName ?? undefined,
    cpu: snapshot.resources.vcpus,
    mem: snapshot.resources.memoryGib,
    disk: snapshot.resources.diskGib,
    createdAt: new Date(snapshot.createdAt),
  };
}
