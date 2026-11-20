/**
 * Reloading runtime settings with no restart (spec 028, "Reload"). A reload
 * can add a runtime and change presets, sizes and limits. It never stops a
 * rig, so it refuses to remove a runtime that has rigs.
 *
 * The daemon writes each reload's result to `reload-result.json`, with a
 * number that goes up each time, so `amika-hostd reload` can wait for the
 * result of the signal it sent.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { HostdConfig } from "./config.js";
import { writePrivateFile } from "./private-file.js";
import { RUNTIME_NAMES, type RuntimeName } from "./runtimes.js";

/** Settings a reload does not apply: the daemon must restart for them. */
const RESTART_SETTINGS = [
  "apiUrl",
  "hostname",
  "secretStore",
  "host",
  "port",
  "snapshotDir",
  "transport",
  "tunnelGatewayUrl",
  "tunnelResume",
  "amikadPath",
] as const satisfies readonly (keyof HostdConfig)[];

/**
 * Whether `next` can replace `current`'s runtime settings, given each
 * machine and its runtime. The error names what to change; the warnings
 * name settings that wait for a restart.
 */
export function checkReload(
  current: HostdConfig,
  next: HostdConfig,
  machines: readonly [string, RuntimeName][],
): { error?: string; warnings: string[] } {
  const warnings = RESTART_SETTINGS.filter(
    (key) => current[key] !== next[key],
  ).map((key) => `${key} changed; restart amika-hostd to apply it`);
  const was = current.runtimes.runtimes;
  const will = next.runtimes.runtimes;
  for (const runtime of RUNTIME_NAMES) {
    const rigs = machines
      .filter(([, owner]) => owner === runtime)
      .map(([name]) => name);
    if (was[runtime] && !will[runtime] && rigs.length > 0) {
      return {
        error: `${runtime} has ${rigs.length} rig${rigs.length === 1 ? "" : "s"} (${rigs.join(", ")}). Delete ${rigs.length === 1 ? "it" : "them"}, then try again.`,
        warnings,
      };
    }
    if (
      was[runtime] &&
      will[runtime] &&
      was[runtime].storageDir !== will[runtime].storageDir &&
      rigs.length > 0
    ) {
      return {
        error: `runtimes.${runtime}.storage_dir cannot change while ${runtime} has rigs (${rigs.join(", ")})`,
        warnings,
      };
    }
  }
  // smolvm starts with the daemon, so turning smol on needs a restart.
  if (!was.smol && will.smol) {
    return {
      error:
        "turning on smol needs a restart: run `amika-hostd down`, then `amika-hostd up`",
      warnings,
    };
  }
  return { warnings };
}

export interface ReloadResult {
  /** Goes up by one with each reload the daemon runs. */
  seq: number;
  ok: boolean;
  /** Why the reload failed; the daemon kept its old settings. */
  error?: string;
  warnings: string[];
}

const resultSchema = z.object({
  seq: z.int().nonnegative(),
  ok: z.boolean(),
  error: z.string().optional(),
  warnings: z.array(z.string()),
});

/** The last reload's result, or undefined before the first reload. */
export function readReloadResult(file: string): ReloadResult | undefined {
  try {
    return resultSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export function writeReloadResult(file: string, result: ReloadResult): void {
  writePrivateFile(file, `${JSON.stringify(result, null, 2)}\n`);
}
