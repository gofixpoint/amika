/**
 * The `smolmachines` SDK surface this provider calls: its public `Machine`
 * API, and nothing beneath it. Typed as two small interfaces so tests inject
 * a fake (`smolvmSdkOperations`'s `machines` argument) instead of booting
 * VMs. The SDK loads its native engine only on the first local machine call,
 * so importing this module is cheap on hosts that never use the provider.
 */
import { Machine } from "smolmachines";
import { z } from "zod";
import type {
  ConnectOptions,
  ListOptions,
  LocalAvailability,
  MachineConfig,
  MachineSummary,
} from "smolmachines";

/** The static half of `Machine`: create, connect, list, host check. */
export interface SmolMachines {
  create(config: MachineConfig, conn: ConnectOptions): Promise<SmolMachine>;
  connect(name: string, conn: ConnectOptions): Promise<SmolMachine>;
  list(conn: ConnectOptions, options: ListOptions): Promise<MachineSummary[]>;
  localAvailability(): LocalAvailability;
}

/**
 * The instance half: a `Machine`'s methods this provider calls. Never its
 * `state()`: that waits, on the event loop, for the machine's lock, which a
 * file transfer holds throughout. `Machine.list` reports the same state
 * without blocking.
 */
export interface SmolMachine {
  start(): Promise<void>;
  /** Restore execution saved by a pause (through the `smol` CLI, say). */
  resume(): Promise<void>;
  stop(): Promise<void>;
  delete(): Promise<void>;
  exec(
    command: string[],
    options?: { env?: Record<string, string>; workdir?: string; user?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Uint8Array, mode?: number): Promise<void>;
}

/** The real SDK. */
export const smolMachines: SmolMachines = Machine;

/**
 * Every call targets the local engine. The embedding process owns shutdown,
 * so the SDK must not stop machines and re-raise on `SIGINT`/`SIGTERM`.
 */
export const LOCAL: ConnectOptions = { target: "local", handleSignals: false };

/** The part of an SDK error (`SmolError`) callers branch on: its code. */
const smolErrorSchema = z.object({ code: z.string() });

/** An SDK error's code (`SmolError.code`), or `""` for any other error. */
export function smolErrorCode(error: unknown): string {
  const parsed = smolErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : "";
}
