/**
 * The machine runtime of a bare-metal host: one rig, which is this machine
 * itself, and nothing on it but the SSH bridge.
 *
 * There is no VM to create or boot. A rig is a record in
 * `bare-metal-rig.json` (its name, state, and the two loopback ports its
 * amikad and amikad's sshd listen on), and running means hostd's supervised
 * `amikad serve` (`amikad-supervisor.ts`) is up. hostd runs amikad as the
 * operator's own account, in amikad's user mode (`AMIKAD_STATE_DIR`), so
 * nothing is written to a system path and nothing runs as root.
 *
 * The control plane still provisions the bridge through exec, as for a VM.
 * Exec here accepts only those fixed amikad commands, decided by this host's
 * own type and never by the request: the machine belongs to someone, and
 * the control plane must not be able to run anything else on it. Files and
 * snapshots are not served at all (`src/app.ts`).
 */
import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { z } from "zod";
import type { HostResources } from "../platforms/index.js";
import {
  amikadSupervisor,
  type AmikadSupervisor,
  type AmikadSupervisorOptions,
} from "./amikad-supervisor.js";
import type { Spawn } from "./daemon.js";
import {
  RuntimeError,
  type ExecResult,
  type MachineInfo,
  type MachineRuntime,
} from "./machine-runtime.js";
import { writePrivateFile } from "./private-file.js";
import { AMIKAD_PORT } from "./services.js";

/** The one service a bare-metal rig serves: amikad, for SSH. */
export const AMIKAD_SERVICE_NAME = "amikad";

/**
 * The commands exec accepts, each exactly as the control plane sends it
 * (`["/bin/sh", "-c", <command>]`), mapped to the amikad argv hostd runs in
 * its place. `serve` is not run as given: hostd (re)starts its own
 * supervised `amikad serve` instead.
 */
export const BARE_METAL_EXEC_ALLOWLIST: ReadonlyMap<string, AllowedCommand> =
  new Map<string, AllowedCommand>([
    [
      "amikad connect-token set",
      { kind: "run", args: ["connect-token", "set"], stdin: true },
    ],
    [
      "amikad setup sshd --force-overwrite",
      {
        kind: "run",
        args: ["setup", "sshd", "--force-overwrite"],
        stdin: false,
      },
    ],
    [
      "amikad authorized-keys set",
      { kind: "run", args: ["authorized-keys", "set"], stdin: true },
    ],
    [
      "amikad authorized-keys clear",
      { kind: "run", args: ["authorized-keys", "clear"], stdin: false },
    ],
    [
      "amikad host-key show",
      { kind: "run", args: ["host-key", "show"], stdin: false },
    ],
    ["amikad serve --beta-no-relay --bg", { kind: "serve" }],
  ]);

export type AllowedCommand =
  | { kind: "run"; args: readonly string[]; stdin: boolean }
  | { kind: "serve" };

/**
 * What exec may do with `command`, or undefined when it may do nothing. Only
 * exactly `["/bin/sh", "-c", C]` with `C` one of the allowlisted strings,
 * byte for byte: no trimming, no other shell, no extra arguments.
 */
export function allowedCommand(
  command: readonly string[],
): AllowedCommand | undefined {
  if (command.length !== 3) return undefined;
  const [shell, flag, script] = command;
  if (shell !== "/bin/sh" || flag !== "-c") return undefined;
  return BARE_METAL_EXEC_ALLOWLIST.get(script);
}

/** The file amikad keeps its connect token in, under its state directory. */
export const AMIKAD_CONNECT_TOKEN_FILE = "connect-token";

export interface BareMetalRuntime extends MachineRuntime {
  /**
   * `up` found the rig running: restart `amikad serve` if amikad holds a
   * connect token (the bridge was provisioned before hostd stopped).
   */
  resume(): Promise<void>;
  /** Stop `amikad serve`, leaving the rig's record as it is. */
  shutdown(): Promise<void>;
}

export interface BareMetalRuntimeOptions {
  /** Where the one rig is recorded (`bare-metal-rig.json`). */
  rigFile: string;
  /** hostd's state directory, which `amikadStateDir` must be inside. */
  stateDir: string;
  /** amikad's `AMIKAD_STATE_DIR`; deleting the rig deletes it. */
  amikadStateDir: string;
  /** The installed amikad, by absolute path. */
  amikad: string;
  /** Where `amikad serve`'s output goes. */
  logFile: string;
  /** This machine's capacity, reported as the rig's size. */
  resources: () => HostResources;
  /** A free loopback port; tests inject a fake. */
  freePort?: () => Promise<number>;
  /** How long one allowlisted amikad command may run. */
  execTimeoutMs?: number;
  /** Tuning for the supervised `amikad serve`, for tests. */
  supervisor?: Partial<
    Pick<
      AmikadSupervisorOptions,
      | "readyTimeoutMs"
      | "restartDelayMs"
      | "maxRestartDelayMs"
      | "stableMs"
      | "stopTimeoutMs"
      | "fetch"
    >
  >;
  err?: (line: string) => void;
  spawn?: Spawn;
  now?: () => Date;
}

/** The runtime over this machine, refusing to start with an unsafe layout. */
export function bareMetalRuntime({
  rigFile,
  stateDir,
  amikadStateDir,
  amikad,
  logFile,
  resources,
  freePort = freeLoopbackPort,
  execTimeoutMs = 60_000,
  supervisor: tuning = {},
  err = () => {},
  spawn = nodeSpawn,
  now = () => new Date(),
}: BareMetalRuntimeOptions): BareMetalRuntime {
  // Checked up front as well as at delete, so a misconfigured layout fails
  // at startup rather than when a rig is deleted.
  assertInside(stateDir, amikadStateDir);
  if (!path.isAbsolute(amikad)) {
    throw new Error(`amikad must be an absolute path, not ${amikad}`);
  }
  let rig = readRig(rigFile);
  const serve: AmikadSupervisor = amikadSupervisor({
    binary: amikad,
    args: ["serve", "--beta-no-relay"],
    env: () => amikadEnv(requireRig()),
    cwd: amikadStateDir,
    logFile,
    healthUrl: () => `http://127.0.0.1:${requireRig().amikadPort}/healthz`,
    err,
    spawn,
    ...tuning,
  });

  return {
    list: async () => (rig ? [info(rig)] : []),
    get: async (name) => info(find(name)),
    create: async (machine) => {
      if (rig) {
        throw refused(
          409,
          `this bare-metal host already has rig ${rig.name}; a bare-metal host runs one rig at a time`,
        );
      }
      if (machine.env?.length) {
        throw refused(
          400,
          "a bare-metal host takes no environment variables; nothing is copied onto the machine",
        );
      }
      const other = (machine.services ?? []).find(
        (s) => s.name !== AMIKAD_SERVICE_NAME || s.port !== AMIKAD_PORT,
      );
      if (other) {
        throw refused(
          400,
          `a bare-metal host serves only ${AMIKAD_SERVICE_NAME} on port ${AMIKAD_PORT}`,
        );
      }
      // The image, sizes and network a VM create carries mean nothing here:
      // the rig is this machine, as it is.
      const amikadPort = await freePort();
      let sshdPort = await freePort();
      while (sshdPort === amikadPort) sshdPort = await freePort();
      save({
        name: machine.name,
        state: "running",
        amikadPort,
        sshdPort,
        createdAt: now().toISOString(),
      });
      return info(requireRig());
    },
    // Running means the control plane may provision the bridge, which it
    // does next and ends with `serve`; hostd starts nothing on its own.
    start: async (name) => {
      save({ ...find(name), state: "running" });
      return info(requireRig());
    },
    stop: async (name) => {
      const found = find(name);
      await serve.stop();
      save({ ...found, state: "stopped" });
      return info(requireRig());
    },
    remove: async (name) => {
      find(name);
      await serve.stop();
      removeInside(stateDir, amikadStateDir);
      rmSync(rigFile, { force: true });
      rig = undefined;
    },
    exec: async (name, request) => {
      const found = find(name);
      const allowed = allowedCommand(request.command);
      if (!allowed) {
        throw refused(
          403,
          "a bare-metal host runs only the amikad commands that set up SSH",
        );
      }
      // As exec boots a stopped VM first.
      if (found.state !== "running") save({ ...found, state: "running" });
      mkdirSync(amikadStateDir, { recursive: true, mode: 0o700 });
      if (allowed.kind === "serve") {
        const started = await serve.start();
        return started.ok
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: `${started.reason}\n` };
      }
      // The request's user, workdir and env are ignored: amikad runs as the
      // operator, in its own state directory, with only its own settings.
      return runAmikad(
        allowed.args,
        allowed.stdin ? request.stdin : undefined,
        requireRig(),
      );
    },
    readFile: async () => {
      throw refused(404, "a bare-metal host serves no files");
    },
    writeFile: async () => {
      throw refused(404, "a bare-metal host serves no files");
    },
    checkServices: async (name, services) => {
      find(name);
      const other = services.find(
        (s) => s.name !== AMIKAD_SERVICE_NAME || s.port !== AMIKAD_PORT,
      );
      if (other) {
        throw new RuntimeError(
          409,
          `a bare-metal host serves only ${AMIKAD_SERVICE_NAME} on port ${AMIKAD_PORT}; rig ${name} cannot serve ${other.name} on ${other.port}`,
        );
      }
    },
    // amikad's guest port is its loopback listener; nothing else is served.
    hostPort: async (name, guestPort) =>
      rig?.name === name && rig.state === "running" && guestPort === AMIKAD_PORT
        ? rig.amikadPort
        : null,
    resume: async () => {
      if (rig?.state !== "running") return;
      if (!existsSync(path.join(amikadStateDir, AMIKAD_CONNECT_TOKEN_FILE))) {
        return;
      }
      const started = await serve.start();
      if (!started.ok) err(`amika-hostd: ${started.reason}`);
    },
    shutdown: () => serve.stop(),
  };

  function find(name: string): BareMetalRig {
    if (rig?.name !== name) throw refused(404, `no rig named ${name}`);
    return rig;
  }

  function requireRig(): BareMetalRig {
    if (!rig) throw refused(404, "this bare-metal host has no rig");
    return rig;
  }

  function save(next: BareMetalRig) {
    writePrivateFile(rigFile, `${JSON.stringify(next, null, 2)}\n`);
    rig = next;
  }

  function info(current: BareMetalRig): MachineInfo {
    const { vcpus, memoryGib, diskGib } = resources();
    return {
      name: current.name,
      state: current.state,
      cpus: vcpus,
      memoryMb: Math.round(memoryGib * 1024),
      storageGb: Math.max(1, Math.round(diskGib)),
      ports:
        current.state === "running"
          ? [{ host: current.amikadPort, guest: AMIKAD_PORT }]
          : [],
    };
  }

  /**
   * amikad's whole environment: user mode, its loopback listener and sshd
   * port, and a minimal `PATH`. Nothing of hostd's own (no secret, no
   * `AMIKA_*` setting) and nothing from the request reaches it.
   */
  function amikadEnv(current: BareMetalRig): NodeJS.ProcessEnv {
    return {
      AMIKAD_STATE_DIR: amikadStateDir,
      AMIKAD_LISTEN: `127.0.0.1:${current.amikadPort}`,
      AMIKAD_SSHD_PORT: String(current.sshdPort),
      PATH: MINIMAL_PATH,
    };
  }

  /** Run amikad by path with `args`, never through a shell. */
  function runAmikad(
    args: readonly string[],
    stdin: string | undefined,
    current: BareMetalRig,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(amikad, args, {
        cwd: amikadStateDir,
        env: amikadEnv(current),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(refused(504, `amikad ${args.join(" ")} timed out`));
      }, execTimeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          refused(
            500,
            error.code === "ENOENT"
              ? `amikad is not installed at ${amikad}; run \`amika-hostd setup\``
              : `cannot run amikad: ${error.code ?? error.message}`,
          ),
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout);
        const errOut = Buffer.concat(stderr);
        resolve({
          exitCode: code ?? (signal ? 128 : 1),
          stdout: out.toString("utf8"),
          stderr: errOut.toString("utf8"),
          stdoutB64: out.toString("base64"),
          stderrB64: errOut.toString("base64"),
        });
      });
      // A closed stdin, or the token or keys the control plane sent.
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin ?? "");
    });
  }
}

/** Enough to find `sshd` and the tools amikad shells out to, and no more. */
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const bareMetalRigSchema = z.object({
  name: z.string().min(1),
  state: z.enum(["running", "stopped"]),
  amikadPort: z.number().int().min(1).max(65_535),
  sshdPort: z.number().int().min(1).max(65_535),
  createdAt: z.string(),
});
type BareMetalRig = z.infer<typeof bareMetalRigSchema>;

/** The recorded rig, or undefined when there is none. */
function readRig(file: string): BareMetalRig | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return bareMetalRigSchema.parse(JSON.parse(contents));
}

/**
 * A refusal the machine API passes on whole: it names nothing secret, and
 * the operator (or the control plane) needs the reason.
 */
function refused(status: number, reason: string): RuntimeError {
  return new RuntimeError(status, reason, reason);
}

/**
 * Throw unless `target` is strictly inside `root`, as written and with
 * symbolic links resolved, so a delete can never reach anything outside
 * hostd's own state directory.
 */
export function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isStrictlyInside(resolvedRoot, resolvedTarget)) {
    throw new Error(
      `${resolvedTarget} is not inside hostd's state directory ${resolvedRoot}`,
    );
  }
  // With symbolic links resolved (as far as the paths exist yet), the
  // target's parent must still be inside the root, or be the root.
  const realRoot = resolvedThroughLinks(resolvedRoot);
  const realParent = resolvedThroughLinks(path.dirname(resolvedTarget));
  if (realParent !== realRoot && !isStrictlyInside(realRoot, realParent)) {
    throw new Error(
      `${resolvedTarget} resolves outside hostd's state directory ${resolvedRoot}`,
    );
  }
}

/**
 * `file` with symbolic links resolved in the part of it that exists: the
 * deepest existing ancestor's real path, joined with the rest.
 */
function resolvedThroughLinks(file: string): string {
  let existing = file;
  while (!existsSync(existing) && existing !== path.dirname(existing)) {
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), path.relative(existing, file));
}

/**
 * Delete `target`, which must be inside `root`. A symbolic link there is
 * removed itself, never followed.
 */
function removeInside(root: string, target: string): void {
  assertInside(root, target);
  let isLink = false;
  try {
    isLink = lstatSync(target).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (isLink) rmSync(target, { force: true });
  else rmSync(target, { recursive: true, force: true });
}

function isStrictlyInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

/** A loopback port free right now, as the kernel picks one. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}
