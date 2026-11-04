/**
 * One machine API over all the runtimes that are on (spec 028, "hostd with
 * more than one runtime"). Each call goes to the runtime that owns the
 * machine, which the machine index records.
 *
 * - A machine name is unique across all runtimes.
 * - A create, a start, and an exec or file call on a stopped machine (each
 *   can boot it) refuse with 409 when the runtime is at its `max_running`.
 * - List merges every runtime's machines, and each one names its `runtime`.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  RuntimeError,
  type MachineInfo,
  type MachineRuntime,
} from "./machine-runtime.js";
import { writePrivateFile } from "./private-file.js";
import { RUNTIME_NAMES, type RuntimeName } from "./runtimes.js";

/** A machine as the router reports it: also the runtime that owns it. */
export type RoutedMachine = MachineInfo & { runtime: RuntimeName };

export interface RuntimeRouter extends MachineRuntime {
  list(): Promise<RoutedMachine[]>;
  get(name: string): Promise<RoutedMachine>;
  /** The runtime that owns `name`, or undefined for an unknown machine. */
  runtimeOf(name: string): RuntimeName | undefined;
  /**
   * Record each runtime's machines that the index does not have yet, as on
   * startup: machines made before the index existed, or whose create the
   * last run did not finish recording.
   */
  reconcile(): Promise<void>;
  /** Turn a runtime on (with its runtime) or off (undefined), on reload. */
  setRuntime(name: RuntimeName, runtime: MachineRuntime | undefined): void;
  /** Every machine the index records, and its runtime. */
  indexed(): [string, RuntimeName][];
}

export interface RuntimeRouterConfig {
  /** The runtime of each runtime name that is on. */
  runtimes: Partial<Record<RuntimeName, MachineRuntime>>;
  /** The effective `max_running` of each runtime; read on each call. */
  maxRunning: () => Partial<Record<RuntimeName, number | undefined>>;
  index: MachineIndex;
}

/**
 * Route machine calls. A create names its runtime (`CreateMachine.runtime`);
 * one with none goes to smol, as every create did before runtimes existed.
 */
export function runtimeRouter({
  runtimes: initial,
  maxRunning,
  index,
}: RuntimeRouterConfig): RuntimeRouter {
  // A reload adds and removes runtimes (`setRuntime`).
  const runtimes = { ...initial };
  const on = () => RUNTIME_NAMES.filter((name) => runtimes[name] !== undefined);
  /**
   * The runtime that owns `name`. A machine the index does not know goes
   * to the only runtime that is on, so a host with one runtime acts as it
   * did before the index; with more, it is not found.
   */
  const route = (name: string): [RuntimeName, MachineRuntime] => {
    const owner = index.get(name) ?? (on().length === 1 ? on()[0] : undefined);
    const runtime = owner && runtimes[owner];
    if (!owner || !runtime) {
      throw new RuntimeError(404, `machine ${name} not found`);
    }
    return [owner, runtime];
  };
  /** Refuse to boot one more machine on a runtime at its limit. */
  const checkRoom = async (owner: RuntimeName) => {
    const limit = maxRunning()[owner];
    if (limit === undefined) return;
    const running = (await runtimes[owner]!.list()).filter(
      (machine) => machine.state === "running",
    ).length;
    if (running >= limit) {
      throw new RuntimeError(
        409,
        `host is full: ${owner} runs ${limit} rigs at most`,
        `host is full: ${owner} runs ${limit} rig${limit === 1 ? "" : "s"} at most, and ${running} ${running === 1 ? "is" : "are"} running`,
      );
    }
  };
  /** As `checkRoom`, for a call that boots the machine only if it is stopped. */
  const checkRoomToBoot = async (name: string) => {
    const [owner, runtime] = route(name);
    if (maxRunning()[owner] === undefined) return;
    if ((await runtime.get(name)).state !== "running") await checkRoom(owner);
  };
  const routed = (owner: RuntimeName, machine: MachineInfo): RoutedMachine => ({
    ...machine,
    runtime: owner,
  });

  return {
    setRuntime: (name, runtime) => {
      if (runtime) runtimes[name] = runtime;
      else delete runtimes[name];
    },
    indexed: () => index.entries(),
    runtimeOf: (name) => {
      try {
        return route(name)[0];
      } catch {
        return undefined;
      }
    },
    reconcile: async () => {
      for (const owner of on()) {
        for (const machine of await runtimes[owner]!.list()) {
          if (index.get(machine.name) === undefined) {
            index.set(machine.name, owner);
          }
        }
      }
    },
    list: async () => {
      const lists = await Promise.all(
        on().map(async (owner) =>
          (await runtimes[owner]!.list()).map((m) => routed(owner, m)),
        ),
      );
      return lists.flat();
    },
    get: async (name) => {
      const [owner, runtime] = route(name);
      return routed(owner, await runtime.get(name));
    },
    create: async (machine) => {
      const owner = machine.runtime ?? "smol";
      const runtime = runtimes[owner];
      if (!runtime) {
        throw new RuntimeError(
          400,
          `runtime ${owner} is not on`,
          `runtime ${owner} is not on this host`,
        );
      }
      const taken = index.get(machine.name);
      if (taken !== undefined && taken !== owner) {
        throw new RuntimeError(
          409,
          `machine ${machine.name} exists`,
          `a ${taken} machine is named ${machine.name}`,
        );
      }
      await checkRoom(owner);
      // Recorded first, so a create cut short is still found, and deleted,
      // through its runtime.
      index.set(machine.name, owner);
      try {
        return routed(owner, await runtime.create(machine));
      } catch (error) {
        // The runtime cleans up a create that fails. Keep the record only
        // if a machine of that name is still there.
        const exists = await runtime.get(machine.name).then(
          () => true,
          () => false,
        );
        if (!exists && taken === undefined) index.remove(machine.name);
        throw error;
      }
    },
    start: async (name) => {
      const [owner, runtime] = route(name);
      await checkRoomToBoot(name);
      return routed(owner, await runtime.start(name));
    },
    stop: async (name) => {
      const [owner, runtime] = route(name);
      return routed(owner, await runtime.stop(name));
    },
    remove: async (name) => {
      const [, runtime] = route(name);
      try {
        await runtime.remove(name);
      } catch (error) {
        if (error instanceof RuntimeError && error.status === 404) {
          index.remove(name);
        }
        throw error;
      }
      index.remove(name);
    },
    exec: async (name, request) => {
      await checkRoomToBoot(name);
      return route(name)[1].exec(name, request);
    },
    readFile: async (name, path) => {
      await checkRoomToBoot(name);
      return route(name)[1].readFile(name, path);
    },
    writeFile: async (name, path, data) => {
      await checkRoomToBoot(name);
      return route(name)[1].writeFile(name, path, data);
    },
    checkServices: (name, services) =>
      route(name)[1].checkServices(name, services),
    hostPort: async (name, guestPort) => {
      const owner =
        index.get(name) ?? (on().length === 1 ? on()[0] : undefined);
      const runtime = owner && runtimes[owner];
      return runtime ? runtime.hostPort(name, guestPort) : null;
    },
  };
}

/** Which runtime owns each machine hostd made. */
export interface MachineIndex {
  get(name: string): RuntimeName | undefined;
  set(name: string, runtime: RuntimeName): void;
  remove(name: string): void;
  /** Every machine, for a reload that must not remove a runtime with rigs. */
  entries(): [string, RuntimeName][];
}

const indexSchema = z.object({
  machines: z.record(z.string(), z.enum(RUNTIME_NAMES)),
});

/** The index in `file` (`machines.json` in the state directory). */
export function fileMachineIndex(file: string): MachineIndex {
  let machines: Record<string, RuntimeName> = {};
  try {
    machines = indexSchema.parse(
      JSON.parse(readFileSync(file, "utf8")),
    ).machines;
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(`Cannot read the machine index ${file}`, {
        cause: error,
      });
    }
  }
  const save = () =>
    writePrivateFile(file, `${JSON.stringify({ machines }, null, 2)}\n`);
  return {
    get: (name) => (Object.hasOwn(machines, name) ? machines[name] : undefined),
    set: (name, runtime) => {
      if (machines[name] === runtime) return;
      machines = { ...machines, [name]: runtime };
      save();
    },
    remove: (name) => {
      if (!Object.hasOwn(machines, name)) return;
      const { [name]: _removed, ...rest } = machines;
      machines = rest;
      save();
    },
    entries: () => Object.entries(machines),
  };
}

/** An index kept in memory only, for plain `serve` and tests. */
export function memoryMachineIndex(): MachineIndex {
  const machines = new Map<string, RuntimeName>();
  return {
    get: (name) => machines.get(name),
    set: (name, runtime) => void machines.set(name, runtime),
    remove: (name) => void machines.delete(name),
    entries: () => [...machines],
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
