/**
 * The machine API's runtime for macOS rigs: the `lume` sandbox provider from
 * `@amika/sandbox` (spec 026, "The Lume runtime"). Each rig is a clone of a
 * template VM in Lume's default storage, kept in `storage_dir`, and hostd
 * reaches the guest over SSH with a key for that VM only.
 *
 * Service ports are reached through a loopback port that forwards over the
 * VM's management SSH connection to the guest's own loopback. hostd opens
 * one on demand, and it ends when the VM stops: Lume's NAT gives a guest a
 * new address on each boot, and a restart of hostd has none to restore.
 * hostd cannot connect to a guest's address itself: macOS refuses it to a
 * program with no Local Network grant. Port 22 is never forwarded, so users
 * reach a guest only through amikad's SSH bridge.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { shellQuote } from "@amika/sandbox";
import {
  AMIKA_USER,
  LumeCli,
  lumeOperations,
  type LumeConfig,
  type LumeVm,
} from "@amika/sandbox/lume";
import {
  RuntimeError,
  surfaceable,
  type MachineInfo,
  type MachineRuntime,
} from "./machine-runtime.js";

export interface LumeRuntimeConfig {
  /** `runtimes.lume.storage_dir`: hostd's own Lume VMs. */
  storageDir: string;
  /** Where each VM's management key and known hosts are kept. */
  stateDir: string;
  /** The `lume` binary; defaults to `lume` on `PATH`. */
  lumeBin?: string;
}

/** The runtime over Lume, and a way to close its service forwards. */
export interface LumeRuntime extends MachineRuntime {
  shutdown(): Promise<void>;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Never forwarded: users reach a guest only through amikad's SSH bridge. */
const SSH_PORT = 22;

export function lumeRuntime({
  storageDir,
  stateDir,
  lumeBin,
}: LumeRuntimeConfig): LumeRuntime {
  const config: LumeConfig = { storageDir, stateDir, lumeBin };
  const ops = lumeOperations(config);
  const cli = new LumeCli(storageDir, lumeBin);
  // Templates live in Lume's default storage.
  const templates = new LumeCli(undefined, lumeBin);
  const forwards = new Map<string, Map<number, Forward>>();

  /** Run a Lume call, as the machine API answers its failures. */
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (caught) {
      const error =
        caught instanceof AggregateError && caught.errors.length
          ? (caught.errors[0] as unknown)
          : caught;
      if (error instanceof RuntimeError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // macOS counts every macOS VM on the Mac, also ones started outside
      // Amika, so a boot can find the host full when hostd counts fewer.
      if (message.includes(VZ_LIMIT)) {
        throw new RuntimeError(
          409,
          message,
          "host is full: macOS runs at most 2 macOS VMs on this Mac",
        );
      }
      if (
        error instanceof Error &&
        error.name === "SandboxProviderUnsupportedError"
      ) {
        throw new RuntimeError(400, message, surfaceable(message, []));
      }
      throw new RuntimeError(500, message, surfaceable(message, []));
    }
  };
  const find = async (name: string): Promise<LumeVm> => {
    const vm = await call(() => cli.get(name));
    if (!vm) throw new RuntimeError(404, `machine ${name} not found`);
    return vm;
  };
  const info = (vm: LumeVm): MachineInfo => ({
    name: vm.name,
    state: vm.status,
    cpus: vm.cpuCount,
    memoryMb: Math.round(vm.memorySize / MIB),
    storageGb: Math.round(vm.diskSize.total / GIB),
    ports: [...(forwards.get(vm.name) ?? [])].map(([guest, forward]) => ({
      guest,
      host: forward.port,
    })),
  });
  /** The env a machine was created with; ops.remove deletes the file. */
  const envFile = (name: string) =>
    path.join(stateDir, "vms", name, "env.json");
  const createEnv = async (name: string): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(envFile(name), "utf8")) as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  };
  /** Exec and file calls boot a stopped machine first, as smolvm's do. */
  const running = async (name: string) => {
    const vm = await find(name);
    if (vm.status !== "running") await call(() => ops.start(name));
  };
  const closeForwards = async (name: string) => {
    const open = [...(forwards.get(name)?.values() ?? [])];
    forwards.delete(name);
    for (const forward of open) forward.close();
    await Promise.all(open.map((forward) => forward.closed));
  };
  /** A loopback port that reaches `guestPort` on the guest, opened once. */
  const forward = async (name: string, guestPort: number) => {
    const open = forwards.get(name)?.get(guestPort);
    if (open) return open.port;
    const opened = await ops.openForward(name, guestPort);
    const servers = forwards.get(name) ?? new Map<number, Forward>();
    forwards.set(name, servers);
    servers.set(guestPort, opened);
    // A forward ends when its VM stops; the next call opens a new one.
    void opened.closed.then(() => {
      if (forwards.get(name)?.get(guestPort) === opened) {
        forwards.get(name)?.delete(guestPort);
      }
    });
    return opened.port;
  };

  return {
    list: async () => (await call(() => cli.list())).map(info),
    get: async (name) => info(await find(name)),
    create: async (machine) => {
      if (machine.from !== undefined || machine.image === undefined) {
        throw new RuntimeError(400, "Lume boots a template, not a snapshot");
      }
      if ((machine.services ?? []).some((s) => s.port === SSH_PORT)) {
        throw new RuntimeError(400, "port 22 is never a service");
      }
      const image = machine.image;
      const resources = await call(async () => {
        if (machine.cpus === undefined && machine.memoryMb === undefined) {
          return undefined;
        }
        if (machine.cpus === undefined || machine.memoryMb === undefined) {
          throw new RuntimeError(
            400,
            "Lume takes cpus and memoryMb together",
            "Lume takes cpus and memoryMb together",
          );
        }
        const template = await templates.get(image);
        if (!template) {
          throw new RuntimeError(
            400,
            `no Lume template ${image}`,
            `Lume template ${image} is not on this host`,
          );
        }
        const templateDisk = Math.round(template.diskSize.total / GIB);
        const diskGib = machine.storageGb ?? templateDisk;
        if (diskGib < templateDisk) {
          throw new RuntimeError(
            400,
            "disk smaller than the image",
            `the image needs ${templateDisk} GiB of disk; this size has ${diskGib}`,
          );
        }
        return {
          vcpus: machine.cpus,
          memoryGib: machine.memoryMb / 1024,
          diskGib,
        };
      });
      await call(() =>
        ops.create({
          name: machine.name,
          snapshot: image,
          services: [],
          resources,
        }),
      );
      // A VM has no environment of its own, so each exec gets the create's,
      // as a smolvm machine's does.
      await writeFile(
        envFile(machine.name),
        JSON.stringify(
          Object.fromEntries((machine.env ?? []).map((e) => [e.name, e.value])),
        ),
        { mode: 0o600 },
      );
      return info(await find(machine.name));
    },
    start: async (name) => {
      await find(name);
      await call(() => ops.start(name));
      return info(await find(name));
    },
    stop: async (name) => {
      await find(name);
      await closeForwards(name);
      await call(() => ops.stop(name));
      return info(await find(name));
    },
    remove: async (name) => {
      await find(name);
      await closeForwards(name);
      await call(() => ops.remove(name));
    },
    exec: async (name, request) => {
      await running(name);
      if (
        request.user !== undefined &&
        request.user !== AMIKA_USER &&
        request.user !== "root"
      ) {
        throw new RuntimeError(
          400,
          "unsupported exec user",
          `Lume runs commands as ${AMIKA_USER} or root, not ${request.user}`,
        );
      }
      // The machine API takes argv; the guest runs one shell line.
      const line = request.command.map(shellQuote).join(" ");
      // The request's own values win over the create's.
      const env = {
        ...(await createEnv(name)),
        ...Object.fromEntries(
          (request.env ?? []).map((e) => [e.name, e.value]),
        ),
      };
      const result = await call(() =>
        ops.run(name, line, {
          cwd: request.workdir,
          env,
          sudo: request.user === "root",
          input: request.stdin,
        }),
      );
      return { ...result };
    },
    readFile: async (name, path) => {
      await running(name);
      const bytes = await call(() => ops.read(name, path));
      if (bytes === null) throw new RuntimeError(404, `no file ${path}`);
      return {
        body: Readable.toWeb(
          Readable.from([bytes]),
        ) as ReadableStream<Uint8Array>,
        contentType: "application/octet-stream",
      };
    },
    writeFile: async (name, path, data) => {
      await running(name);
      await call(() => ops.write(name, path, Buffer.from(data)));
    },
    // A forward can reach any guest port but 22, so none is refused for
    // not being published at create.
    checkServices: async (name, services) => {
      await find(name);
      if (services.some((s) => s.port === SSH_PORT)) {
        throw new RuntimeError(409, "port 22 is never a service");
      }
    },
    hostPort: async (name, guestPort) => {
      if (guestPort === SSH_PORT) return null;
      try {
        if ((await cli.get(name))?.status !== "running") return null;
        return await forward(name, guestPort);
      } catch {
        return null;
      }
    },
    shutdown: async () => {
      await Promise.all([...forwards.keys()].map(closeForwards));
    },
  };
}

interface Forward {
  port: number;
  close: () => void;
  closed: Promise<void>;
}

/** Virtualization.framework's error for a third macOS VM. */
const VZ_LIMIT =
  "The maximum supported number of active virtual machines has been reached";
