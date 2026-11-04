/**
 * The `lume` CLI, for rig VMs in one storage folder.
 *
 * The CLI, not `lume serve`'s HTTP API: `lume run --detach` gives each VM its
 * own process, and milestone 0 of spec 028 showed that those keep running
 * when the server restarts. A VM booted through the API was not checked.
 */
import { z } from "zod";
import { runProcess, type ProcessRunner } from "./process";

export const lumeVmSchema = z.object({
  name: z.string().min(1),
  status: z.string(),
  ipAddress: z.string().nullish(),
  cpuCount: z.number().int().positive(),
  memorySize: z.number().positive(),
  diskSize: z.object({ total: z.number().positive() }),
});
export type LumeVm = z.infer<typeof lumeVmSchema>;

export class LumeCliError extends Error {
  override name = "LumeCliError";
  constructor(
    readonly subcommand: string,
    readonly exitCode: number,
    /** Lume's own `Error: ...` line, when it printed one. */
    readonly reason: string,
  ) {
    super(`lume ${subcommand} failed (exit ${exitCode}): ${reason}`);
  }

  get notFound(): boolean {
    return this.reason.startsWith("Virtual machine not found");
  }
}

/** Each CLI call returns in seconds; a hung one should not hang the caller. */
const CLI_TIMEOUT_MS = 120_000;

export class LumeCli {
  constructor(
    /** The storage folder; undefined is Lume's default storage. */
    private readonly storageDir: string | undefined,
    private readonly bin = "lume",
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  /** The VM named `name`, or `null` when there is none. */
  async get(name: string): Promise<LumeVm | null> {
    try {
      const out = await this.call("get", [name, "--format", "json"]);
      return z.array(lumeVmSchema).length(1).parse(JSON.parse(out))[0];
    } catch (error) {
      if (error instanceof LumeCliError && error.notFound) return null;
      throw error;
    }
  }

  async list(): Promise<LumeVm[]> {
    return z
      .array(lumeVmSchema)
      .parse(JSON.parse(await this.call("ls", ["--format", "json"])));
  }

  /** Clone `template` from Lume's default storage into this storage. */
  async clone(template: string, name: string): Promise<void> {
    await this.call(
      "clone",
      [
        template,
        name,
        ...(this.storageDir === undefined
          ? []
          : ["--dest-storage", this.storageDir]),
      ],
      { storage: false },
    );
  }

  async set(name: string, cpus?: number, memoryMib?: number): Promise<void> {
    const args = [name];
    if (cpus !== undefined) args.push("--cpu", String(cpus));
    if (memoryMib !== undefined) args.push("--memory", `${memoryMib}MB`);
    if (args.length > 1) await this.call("set", args);
  }

  /**
   * Boot `name` in its own process. Lume exits 0 here even when the VM then
   * fails to start, so the caller must check the VM's state after this.
   */
  async run(name: string, logFile: string): Promise<void> {
    await this.call("run", [
      name,
      "--detach",
      "--display",
      "none",
      "--vnc",
      "disabled",
      "--log-file",
      logFile,
    ]);
  }

  /** Shut down `name`: gracefully first, unless `force`. */
  async stop(name: string, force = false): Promise<void> {
    await this.call("stop", force ? [name, "--force"] : [name]);
  }

  async delete(name: string): Promise<void> {
    await this.call("delete", [name, "--force"]);
  }

  private async call(
    subcommand: string,
    args: string[],
    { storage = true } = {},
  ): Promise<string> {
    const result = await this.runner(
      this.bin,
      [
        subcommand,
        ...args,
        ...(storage && this.storageDir !== undefined
          ? ["--storage", this.storageDir]
          : []),
      ],
      { timeoutMs: CLI_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new LumeCliError(
        subcommand,
        result.exitCode,
        errorLine(result.stderr.toString()),
      );
    }
    return result.stdout.toString();
  }
}

/** Lume prints `Error: <reason>` on stderr, among its log lines. */
function errorLine(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.startsWith("Error: "));
  return line ? line.slice("Error: ".length).trim() : stderr.trim();
}
