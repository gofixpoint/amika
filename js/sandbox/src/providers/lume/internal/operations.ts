/** Rig lifecycle, exec, and files for macOS VMs that Lume runs. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { LumeConfig } from "../config";
import {
  SandboxFileTooLargeError,
  SandboxProviderUnsupportedError,
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
  type ProviderSandboxListing,
  type ReadFileBytesOptions,
  type SandboxExecResult,
} from "../../provider";
import type { SandboxAdapter } from "../../shared/adapter";
import { decodeUtf8 } from "../../shared/adapter";
import type { SandboxStatus } from "../../../sandbox-status";
import { shellQuote } from "../../../util/shell";
import { AMIKA_USER, bootstrapGuest, waitForSsh } from "./bootstrap";
import { GuestSsh, writeAskpass, type GuestAddress } from "./guest-ssh";
import { LumeCli, type LumeVm } from "./lume-cli";
import { runProcess, type ProcessRunner } from "./process";
import { remoteCommand } from "./remote-command";

const PROVIDER = "lume";
const GIB = 1024 ** 3;

export interface LumeDeps {
  cli: LumeCli;
  ssh: GuestSsh;
  /** Runs `ssh-keygen`. */
  runner: ProcessRunner;
}

export function lumeOperations(
  config: LumeConfig,
  deps: LumeDeps = {
    cli: new LumeCli(config.storageDir, config.lumeBin),
    ssh: new GuestSsh(config.sshBin),
    runner: runProcess,
  },
) {
  const { cli, ssh } = deps;
  const bootTimeoutMs = config.bootTimeoutMs ?? 180_000;
  const vmsDir = join(config.stateDir, "vms");
  /** Where one VM's key, known hosts, and Lume log live. */
  const paths = (name: string) => {
    if (!VM_NAME.test(name)) throw new Error("Invalid Lume VM name");
    const dir = join(vmsDir, name);
    return {
      dir,
      keyFile: join(dir, "id_ed25519"),
      knownHostsFile: join(dir, "known_hosts"),
      logFile: join(dir, "lume.log"),
    };
  };
  let askpass: Promise<string> | undefined;
  const askpassFile = () =>
    (askpass ??= mkdir(config.stateDir, { recursive: true, mode: 0o700 }).then(
      () => writeAskpass(config.stateDir),
    ));

  const running = async (id: string): Promise<GuestAddress> => {
    const vm = await cli.get(id);
    if (vm?.status !== "running" || !vm.ipAddress) {
      throw new Error(`Lume VM ${id} is not running`);
    }
    return { ip: vm.ipAddress, knownHostsFile: paths(id).knownHostsFile };
  };
  const withKey = async (id: string, line: string, input?: Buffer | string) =>
    ssh.withKey(await running(id), paths(id).keyFile, AMIKA_USER, line, input);

  const run = async (
    id: string,
    command: string,
    opts?: ExecCommandOptions,
  ): Promise<SandboxExecResult> => {
    const result = await withKey(id, remoteCommand(command, opts), opts?.input);
    return {
      exitCode: result.exitCode,
      stdout: decodeUtf8(result.stdout),
      stderr: decodeUtf8(result.stderr),
    };
  };
  const read = async (
    id: string,
    path: string,
    opts?: ReadFileBytesOptions,
  ): Promise<Uint8Array | null> => {
    // One byte over the cap is enough to know the file is too large.
    const limit = opts?.maxBytes === undefined ? "" : String(opts.maxBytes + 1);
    const result = await withKey(
      id,
      `sudo -n /bin/sh -c ${shellQuote(READ_SCRIPT)} sh ${shellQuote(absolute(path))} ${shellQuote(limit)}`,
    );
    if (result.exitCode === MISSING_EXIT) return null;
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to read ${path}: ${String(result.stderr).trim()}`,
      );
    }
    if (opts?.maxBytes !== undefined && result.stdout.length > opts.maxBytes) {
      throw new SandboxFileTooLargeError(path, opts.maxBytes);
    }
    return new Uint8Array(result.stdout);
  };
  const write = async (
    id: string,
    path: string,
    content: Buffer | string,
  ): Promise<void> => {
    const result = await withKey(
      id,
      `sudo -n /bin/sh -c ${shellQuote(WRITE_SCRIPT)} sh ${shellQuote(absolute(path))}`,
      content,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to write ${path}: ${String(result.stderr).trim()}`,
      );
    }
  };

  /**
   * Boot `name` and wait for its IP. `lume run --detach` exits 0 even when
   * the VM does not start (such as at the host's limit of two macOS VMs), so
   * the reason comes from the VM's Lume log.
   */
  const boot = async (
    name: string,
    deadline: number,
  ): Promise<GuestAddress> => {
    const { logFile, knownHostsFile } = paths(name);
    await writeFile(logFile, "");
    await cli.run(name, logFile);
    for (;;) {
      const vm = await cli.get(name);
      if (vm?.status === "running" && vm.ipAddress) {
        return { ip: vm.ipAddress, knownHostsFile };
      }
      const failure = (await readFile(logFile, "utf8"))
        .split("\n")
        .find((line) => /\bERROR\b|^Error:/.test(line));
      if (failure) throw new Error(`Lume VM ${name} did not start: ${failure}`);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Lume VM ${name} to boot`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };
  const remove = async (id: string): Promise<void> => {
    const { dir } = paths(id);
    const vm = await cli.get(id);
    if (vm) {
      if (vm.status !== "stopped") await cli.stop(id, true);
      await cli.delete(id);
    }
    await rm(dir, { recursive: true, force: true });
  };
  const start = async (id: string, interval?: number | null) => {
    rejectTimer(interval, "autoStopInterval");
    const deadline = Date.now() + bootTimeoutMs;
    const vm = await cli.get(id);
    if (!vm) throw new Error(`Lume VM ${id} does not exist`);
    const { keyFile, knownHostsFile } = paths(id);
    const guest =
      vm.status === "running" && vm.ipAddress
        ? { ip: vm.ipAddress, knownHostsFile }
        : await boot(id, deadline);
    await waitForSsh(
      () => ssh.withKey(guest, keyFile, AMIKA_USER, "true"),
      deadline,
      "key login",
    );
  };

  /**
   * A loopback port on the host that reaches `guestPort` on the guest's
   * loopback, through the VM's management key. `close` ends it; `closed`
   * settles when it ends for any reason, such as the VM stopping.
   */
  const openForward = async (
    id: string,
    guestPort: number,
  ): Promise<{ port: number; close: () => void; closed: Promise<void> }> => {
    const guest = await running(id);
    // ssh binds the port, so pick a free one, and try again if another
    // program takes it first.
    for (let attempt = 1; ; attempt++) {
      const port = await freeLoopbackPort();
      const child = ssh.forward(
        guest,
        paths(id).keyFile,
        AMIKA_USER,
        port,
        guestPort,
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      const ready = await Promise.race([
        waitForPort(port, 15_000).then(() => true),
        closed.then(() => false),
      ]);
      if (ready) return { port, close: () => child.kill(), closed };
      child.kill();
      if (attempt === 3) {
        throw new Error(
          `Failed to forward port ${guestPort} of Lume VM ${id}: ${stderr.trim()}`,
        );
      }
    }
  };

  return {
    openForward,
    adapter: (id: string): SandboxAdapter => ({
      exec: (command, opts) => run(id, command, opts),
      uploadFile: (content, path) => write(id, path, content),
      downloadFile: async (path) => {
        const bytes = await read(id, path);
        return bytes === null ? null : decodeUtf8(bytes);
      },
    }),
    run,
    read,
    write,
    /**
     * Clone the template VM named by `snapshot`, size it, boot it, and run
     * the SSH bootstrap. Only a VM this call cloned is deleted on failure,
     * so a name conflict never deletes an existing VM.
     */
    create: async (
      input: CreateSandboxProviderInput,
    ): Promise<CreatedProviderSandbox> => {
      const { dir, keyFile } = paths(input.name);
      if (!input.snapshot.trim())
        throw new Error("Lume requires a template VM name in snapshot");
      if (input.services.length)
        throw new SandboxProviderUnsupportedError(PROVIDER, "services");
      if (Object.keys(input.envVars ?? {}).length)
        throw new SandboxProviderUnsupportedError(PROVIDER, "envVars");
      rejectTimer(input.autoStopInterval, "autoStopInterval");
      rejectTimer(input.autoDeleteInterval, "autoDeleteInterval");
      const resources =
        input.resources &&
        z
          .object({
            vcpus: z.number().int().min(1),
            memoryGib: z.number().refine((n) => Number.isSafeInteger(n * 1024)),
            diskGib: z.number().int().positive(),
          })
          .parse(input.resources);
      const deadline = Date.now() + bootTimeoutMs;
      const login = {
        askpassFile: await askpassFile(),
        user: config.bootstrapUser ?? "lume",
        password: config.bootstrapPassword ?? "lume",
      };
      await mkdir(vmsDir, { recursive: true, mode: 0o700 });
      // Lume does not make the folder it clones into.
      await mkdir(config.storageDir, { recursive: true });
      await cli.clone(input.snapshot, input.name);
      try {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { mode: 0o700 });
        if (resources) {
          const cloned = await cli.get(input.name);
          // Lume grows a macOS disk only while stopped, in minutes, and
          // never shrinks one, so a rig keeps its template's disk.
          if (cloned && cloned.diskSize.total / GIB !== resources.diskGib)
            throw new SandboxProviderUnsupportedError(PROVIDER, "diskGib");
          await cli.set(
            input.name,
            resources.vcpus,
            resources.memoryGib * 1024,
          );
        }
        const keygen = await deps.runner("ssh-keygen", [
          ...["-q", "-t", "ed25519", "-N", ""],
          ...["-C", `amika-lume-${input.name}`, "-f", keyFile],
        ]);
        if (keygen.exitCode !== 0)
          throw new Error(`ssh-keygen failed: ${String(keygen.stderr).trim()}`);
        const publicKey = (await readFile(`${keyFile}.pub`, "utf8")).trim();
        const guest = await boot(input.name, deadline);
        await bootstrapGuest(ssh, guest, login, keyFile, publicKey, deadline);
      } catch (error) {
        try {
          await remove(input.name);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Lume create and cleanup failed",
          );
        }
        throw error;
      }
      return {
        provider: PROVIDER,
        providerSandboxId: input.name,
        services: [],
      };
    },
    remove,
    start,
    stop: (id: string) => cli.stop(id),
    getState: async (id: string) => (await cli.get(id))?.status ?? "unknown",
    list: async (): Promise<ProviderSandboxListing[]> =>
      (await cli.list()).map(listing),
  };
}

export function mapLumeState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function listing(vm: LumeVm): ProviderSandboxListing {
  return {
    providerSandboxId: vm.name,
    name: vm.name,
    orgId: null,
    state: vm.status,
    sizing: {
      vcpus: vm.cpuCount,
      memoryGib: vm.memorySize / GIB,
      diskGib: vm.diskSize.total / GIB,
    },
  };
}

function rejectTimer(interval: number | null | undefined, operation: string) {
  if (interval != null && interval !== 0)
    throw new SandboxProviderUnsupportedError(PROVIDER, operation);
}

function absolute(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error("Lume file paths must be absolute");
  }
  return path;
}

// A VM name is also a folder name under the state directory.
const VM_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const MISSING_EXIT = 44;

/** Run as root: `$1` is the path, `$2` the byte limit, or empty for none. */
const READ_SCRIPT = `if [ -d "$1" ]; then echo "$1 is a directory" >&2; exit 45; fi
[ -e "$1" ] || exit ${MISSING_EXIT}
if [ -n "$2" ]; then exec head -c "$2" -- "$1"; fi
exec cat -- "$1"`;

/**
 * Run as root, with the content on stdin. As on smol: create the parent as
 * the exec user when it can, write as root, then hand the file to the exec
 * user. `chown -h` changes a symlink itself, never its target.
 */
const WRITE_SCRIPT = `set -e
dir=$(dirname -- "$1")
sudo -n -u ${AMIKA_USER} mkdir -p -- "$dir" 2>/dev/null || mkdir -p -- "$dir"
cat > "$1"
chown -h -- ${AMIKA_USER}:staff "$1"`;

/** A port on 127.0.0.1 that nothing listens on now. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Resolve once a TCP connect to `port` on 127.0.0.1 works. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for port ${port}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
