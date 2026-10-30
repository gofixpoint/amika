/**
 * The in-memory world behind the `simulate` provider.
 *
 * A world holds every simulated sandbox, snapshot, and SSH token, plus the
 * knobs a test turns: a controllable clock, per-operation faults and latency,
 * and scripted command output. The provider's operations (`./operations`)
 * read and write the world; tests reach the same world through
 * {@link getSimulateWorld} to set up a scenario and inspect what happened.
 *
 * Nothing here is random. Ids and tokens come from a counter, and time only
 * moves when the caller moves it, so a scenario replays the same way every
 * run.
 */
import {
  SANDBOX_DELETE_INTERVAL_KEEP_ON_STOP,
  SANDBOX_ORG_ID_LABEL,
} from "../../../constants";
import type { SandboxService } from "../../../types";
import type {
  CreateSandboxProviderInput,
  ExecCommandOptions,
  SandboxExecResult,
  SandboxResources,
  ReadFileBytesOptions,
} from "../../provider";
import { SandboxFileTooLargeError } from "../../provider";
import { executeScrubCommand } from "./scrub-commands";

const DEFAULT_WORLD_ID = "default";

const worlds = new Map<string, SimulateWorld>();

/**
 * The process-wide world for `worldId`, created on first use. The provider and
 * its tests meet here: the registry builds the provider over this world, and a
 * test calls this with the same id to drive it.
 */
export function getSimulateWorld(
  worldId: string = DEFAULT_WORLD_ID,
): SimulateWorld {
  let world = worlds.get(worldId);
  if (!world) {
    world = new SimulateWorld();
    worlds.set(worldId, world);
  }
  return world;
}

/** Drop every world. Call between tests that share a process. */
export function resetSimulateWorlds(): void {
  worlds.clear();
}

/** Every provider operation a fault or latency can be attached to. */
export type SimulateOperation =
  | "create"
  | "delete"
  | "start"
  | "stop"
  | "getState"
  | "exec"
  | "readFile"
  | "writeFile"
  | "list"
  | "refreshUrls"
  | "syncRoutes"
  | "sshMint"
  | "sshRevoke"
  | "getSnapshot"
  | "deleteSnapshot"
  | "waitForSnapshotActive"
  | "captureSnapshot"
  | "createImageSnapshot";

/** The raw run state a simulated sandbox reports. */
export type SimulateVmState = "running" | "stopped";

export const DEFAULT_SIMULATE_RESOURCES: SandboxResources = {
  vcpus: 2,
  memoryGib: 4,
  diskGib: 10,
};

export interface SimulateVm {
  id: string;
  name: string;
  snapshot: string;
  orgId: string | null;
  labels: Record<string, string>;
  envVars: Record<string, string>;
  resources: SandboxResources;
  services: SandboxService[];
  /** Routes the last `syncRoutes` reconciled to. */
  routes: SandboxService[];
  /** Minutes of inactivity before the world stops the sandbox; 0 never. */
  autoStopInterval: number;
  /** Minutes after a stop before deletion; 0 immediately, -1 never. */
  autoDeleteInterval: number;
  scrubSafe: boolean;
  state: SimulateVmState;
  createdAt: number;
  lastActiveAt: number;
  stoppedAt: number | null;
  files: Map<string, Uint8Array>;
}

export interface SimulateSnapshot {
  name: string;
  state: "active";
  resources: SandboxResources;
  /** Set when the snapshot was made from an image rather than a sandbox. */
  imageName: string | null;
  createdAt: number;
  files: Map<string, Uint8Array>;
}

export interface SimulateExecCall {
  vmId: string;
  command: string;
  opts: ExecCommandOptions | undefined;
  at: number;
}

/**
 * Scripted output for a command. Receives the call and the sandbox it ran
 * in, so a handler can read or change the sandbox's files.
 */
export type SimulateExecHandler = (
  call: SimulateExecCall,
  vm: SimulateVm,
) => SandboxExecResult;

/** Thrown when an operation names a sandbox or snapshot the world lacks. */
export class SimulateNotFoundError extends Error {
  readonly kind: "sandbox" | "snapshot";
  readonly id: string;
  constructor(kind: "sandbox" | "snapshot", id: string) {
    super(`Simulated ${kind} "${id}" not found`);
    this.name = "SimulateNotFoundError";
    this.kind = kind;
    this.id = id;
  }
}

/** Thrown by an operation a test armed with {@link SimulateWorld.failNext}. */
export class SimulateFaultError extends Error {
  readonly operation: SimulateOperation;
  constructor(operation: SimulateOperation, message?: string) {
    super(message ?? `Simulated fault in "${operation}"`);
    this.name = "SimulateFaultError";
    this.operation = operation;
  }
}

const OK: SandboxExecResult = { exitCode: 0, stdout: "", stderr: "" };

export class SimulateWorld {
  /** Every command run in this world, oldest first. */
  readonly execLog: SimulateExecCall[] = [];

  private readonly vmsById = new Map<string, SimulateVm>();
  private readonly snapshotsByName = new Map<string, SimulateSnapshot>();
  /** SSH token → sandbox id. */
  private readonly sshTokens = new Map<string, string>();
  private readonly execHandlers: Array<{
    matcher: string | RegExp;
    handler: SimulateExecHandler;
  }> = [];
  private readonly queuedFaults = new Map<SimulateOperation, string[]>();
  private readonly standingFaults = new Map<SimulateOperation, string>();
  private readonly latencyMs = new Map<SimulateOperation, number>();
  private counter = 0;
  private frozenAt: number | null = null;
  private offsetMs = 0;

  // -------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------

  /** The world's current time in epoch milliseconds. */
  now(): number {
    return this.frozenAt ?? Date.now() + this.offsetMs;
  }

  /** Stop the clock at `atMs` (default: now). Only `advanceTime` moves it. */
  freezeTime(atMs: number = this.now()): void {
    this.frozenAt = atMs;
  }

  /**
   * Move the clock forward and apply what time does: stop sandboxes idle past
   * their auto-stop interval, delete stopped sandboxes past their auto-delete
   * interval.
   */
  advanceTime(ms: number): void {
    if (this.frozenAt !== null) {
      this.frozenAt += ms;
    } else {
      this.offsetMs += ms;
    }
    this.reap();
  }

  // -------------------------------------------------------------------------
  // Scenario knobs
  // -------------------------------------------------------------------------

  /** Make the next call to `operation` throw, once. Calls queue in order. */
  failNext(operation: SimulateOperation, message?: string): void {
    const queue = this.queuedFaults.get(operation) ?? [];
    queue.push(message ?? `Simulated fault in "${operation}"`);
    this.queuedFaults.set(operation, queue);
  }

  /** Make every call to `operation` throw until `clearFaults`. */
  failAlways(operation: SimulateOperation, message?: string): void {
    this.standingFaults.set(
      operation,
      message ?? `Simulated fault in "${operation}"`,
    );
  }

  /** Clear queued and standing faults, for one operation or for all. */
  clearFaults(operation?: SimulateOperation): void {
    if (operation) {
      this.queuedFaults.delete(operation);
      this.standingFaults.delete(operation);
      return;
    }
    this.queuedFaults.clear();
    this.standingFaults.clear();
  }

  /** Delay every call to `operation` by `ms` of real time. */
  setLatency(operation: SimulateOperation, ms: number): void {
    this.latencyMs.set(operation, ms);
  }

  /**
   * Script the output of commands that match `matcher` (an exact command
   * string, or a RegExp tested against it). The newest matching handler wins.
   * Returns a function that removes the handler. Shared scrub commands update
   * the stored filesystem; other unmatched commands exit 0 with empty output.
   */
  onExec(
    matcher: string | RegExp,
    handler: SimulateExecHandler | SandboxExecResult,
  ): () => void {
    const entry = {
      matcher,
      handler: typeof handler === "function" ? handler : () => handler,
    };
    this.execHandlers.push(entry);
    return () => {
      const index = this.execHandlers.indexOf(entry);
      if (index >= 0) this.execHandlers.splice(index, 1);
    };
  }

  /**
   * Remove a sandbox without a stop or delete call, as a provider outage or an
   * out-of-band deletion would. It drops out of listings and every later call
   * on it throws {@link SimulateNotFoundError}.
   */
  vanish(vmId: string): void {
    this.vmsById.delete(vmId);
  }

  /** Forget every sandbox, snapshot, token, fault, handler, and log entry. */
  reset(): void {
    this.vmsById.clear();
    this.snapshotsByName.clear();
    this.sshTokens.clear();
    this.execHandlers.length = 0;
    this.execLog.length = 0;
    this.queuedFaults.clear();
    this.standingFaults.clear();
    this.latencyMs.clear();
    this.counter = 0;
    this.frozenAt = null;
    this.offsetMs = 0;
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  vms(): SimulateVm[] {
    return [...this.vmsById.values()];
  }

  vm(vmId: string): SimulateVm | undefined {
    return this.vmsById.get(vmId);
  }

  requireVm(vmId: string): SimulateVm {
    const vm = this.vmsById.get(vmId);
    if (!vm) throw new SimulateNotFoundError("sandbox", vmId);
    return vm;
  }

  snapshots(): SimulateSnapshot[] {
    return [...this.snapshotsByName.values()];
  }

  snapshot(name: string): SimulateSnapshot | undefined {
    return this.snapshotsByName.get(name);
  }

  /** Tokens minted for `vmId` that have not been revoked. */
  sshTokensFor(vmId: string): string[] {
    return [...this.sshTokens.entries()]
      .filter(([, id]) => id === vmId)
      .map(([token]) => token);
  }

  // -------------------------------------------------------------------------
  // Operation gate
  // -------------------------------------------------------------------------

  /**
   * Run one provider operation through the world's faults and latency. Every
   * operation in `./operations` goes through here, so a scenario can make any
   * of them fail or stall.
   */
  async perform<T>(operation: SimulateOperation, run: () => T): Promise<T> {
    const standing = this.standingFaults.get(operation);
    if (standing !== undefined) {
      throw new SimulateFaultError(operation, standing);
    }
    const queued = this.queuedFaults.get(operation)?.shift();
    if (queued !== undefined) {
      throw new SimulateFaultError(operation, queued);
    }
    const delay = this.latencyMs.get(operation) ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return run();
  }

  // -------------------------------------------------------------------------
  // State transitions (called by ./operations inside `perform`)
  // -------------------------------------------------------------------------

  createVm(input: CreateSandboxProviderInput): SimulateVm {
    const now = this.now();
    const labels = { ...input.labels };
    const source = this.snapshotsByName.get(input.snapshot);
    const vm: SimulateVm = {
      id: this.nextId("sim-vm"),
      name: input.name,
      snapshot: input.snapshot,
      orgId: labels[SANDBOX_ORG_ID_LABEL] ?? null,
      labels,
      envVars: { ...input.envVars },
      resources: input.resources ??
        source?.resources ?? {
          ...DEFAULT_SIMULATE_RESOURCES,
        },
      services: input.services,
      routes: input.services,
      autoStopInterval: input.autoStopInterval ?? 0,
      autoDeleteInterval:
        input.autoDeleteInterval ?? SANDBOX_DELETE_INTERVAL_KEEP_ON_STOP,
      scrubSafe: input.scrubSafe ?? false,
      state: "running",
      createdAt: now,
      lastActiveAt: now,
      stoppedAt: null,
      files: copyFiles(source?.files),
    };
    this.vmsById.set(vm.id, vm);
    return vm;
  }

  deleteVm(vmId: string): void {
    // Idempotent, like every real provider's delete.
    this.vmsById.delete(vmId);
    for (const token of this.sshTokensFor(vmId)) this.sshTokens.delete(token);
  }

  startVm(vmId: string, autoStopInterval?: number | null): void {
    const vm = this.requireVm(vmId);
    vm.state = "running";
    vm.stoppedAt = null;
    vm.lastActiveAt = this.now();
    if (autoStopInterval != null) vm.autoStopInterval = autoStopInterval;
  }

  stopVm(vmId: string): void {
    const vm = this.requireVm(vmId);
    if (vm.state === "stopped") return;
    vm.state = "stopped";
    vm.stoppedAt = this.now();
    if (vm.autoDeleteInterval === 0) this.deleteVm(vmId);
  }

  exec(
    vmId: string,
    command: string,
    opts: ExecCommandOptions | undefined,
  ): SandboxExecResult {
    const vm = this.requireVm(vmId);
    if (vm.state !== "running") {
      throw new Error(`Simulated sandbox "${vmId}" is not running`);
    }
    vm.lastActiveAt = this.now();
    const call: SimulateExecCall = { vmId, command, opts, at: vm.lastActiveAt };
    this.execLog.push(call);
    for (let i = this.execHandlers.length - 1; i >= 0; i--) {
      const { matcher, handler } = this.execHandlers[i];
      if (matcher instanceof RegExp) matcher.lastIndex = 0;
      const matches =
        typeof matcher === "string"
          ? matcher === command
          : matcher.test(command);
      if (matches) return handler(call, vm);
    }
    return executeScrubCommand(vm.files, command) ?? OK;
  }

  readFile(
    vmId: string,
    path: string,
    opts?: ReadFileBytesOptions,
  ): Uint8Array | null {
    const vm = this.requireVm(vmId);
    const bytes = vm.files.get(path);
    if (
      bytes &&
      opts?.maxBytes !== undefined &&
      bytes.byteLength > opts.maxBytes
    ) {
      throw new SandboxFileTooLargeError(path, opts.maxBytes);
    }
    return bytes ? new Uint8Array(bytes) : null;
  }

  writeFile(vmId: string, path: string, content: Buffer | string): void {
    const vm = this.requireVm(vmId);
    vm.files.set(
      path,
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content),
    );
  }

  mintSsh(vmId: string): string {
    this.requireVm(vmId);
    const token = this.nextId("sim-ssh");
    this.sshTokens.set(token, vmId);
    return token;
  }

  revokeSsh(token: string): void {
    this.sshTokens.delete(token);
  }

  /**
   * Snapshot a sandbox's files and size under `name`. A snapshot that already
   * holds the name is replaced. When the source is not kept running it is
   * stopped, as a cold capture does on real providers.
   */
  captureSnapshot(
    vmId: string,
    name: string,
    keepSourceRunning: boolean,
  ): SimulateSnapshot {
    const vm = this.requireVm(vmId);
    const snapshot: SimulateSnapshot = {
      name,
      state: "active",
      resources: { ...vm.resources },
      imageName: null,
      createdAt: this.now(),
      files: copyFiles(vm.files),
    };
    this.snapshotsByName.set(name, snapshot);
    if (!keepSourceRunning) this.stopVm(vmId);
    return snapshot;
  }

  /** Register an image as a bootable snapshot. `null` when the name is taken. */
  createImageSnapshot(name: string, image: string): SimulateSnapshot | null {
    if (this.snapshotsByName.has(name)) return null;
    const snapshot: SimulateSnapshot = {
      name,
      state: "active",
      resources: { ...DEFAULT_SIMULATE_RESOURCES },
      imageName: image,
      createdAt: this.now(),
      files: new Map(),
    };
    this.snapshotsByName.set(name, snapshot);
    return snapshot;
  }

  deleteSnapshot(name: string): void {
    this.snapshotsByName.delete(name);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(6, "0")}`;
  }

  private reap(): void {
    const now = this.now();
    for (const vm of this.vmsById.values()) {
      if (
        vm.state === "running" &&
        vm.autoStopInterval > 0 &&
        vm.lastActiveAt + minutes(vm.autoStopInterval) <= now
      ) {
        vm.state = "stopped";
        vm.stoppedAt = vm.lastActiveAt + minutes(vm.autoStopInterval);
      }
      if (
        vm.state === "stopped" &&
        vm.autoDeleteInterval >= 0 &&
        vm.stoppedAt !== null &&
        vm.stoppedAt + minutes(vm.autoDeleteInterval) <= now
      ) {
        this.deleteVm(vm.id);
      }
    }
  }
}

function minutes(n: number): number {
  return n * 60_000;
}

function copyFiles(
  files: Map<string, Uint8Array> | undefined,
): Map<string, Uint8Array> {
  const copy = new Map<string, Uint8Array>();
  if (!files) return copy;
  for (const [path, bytes] of files) copy.set(path, new Uint8Array(bytes));
  return copy;
}
