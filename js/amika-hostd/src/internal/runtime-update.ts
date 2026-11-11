/**
 * The config change `amika-hostd capabilities update` makes (spec 028,
 * "`amika-hostd capabilities`"): turn runtimes on or off in
 * `[runtimes.*]`, keeping everything else in `config.toml` as it is.
 */
import { ConfigError } from "./config.js";
import { tomlKey } from "./config-upgrade.js";
import { RUNTIME_NAMES, type RuntimeName } from "./runtimes.js";

/** The preset a Lume host offers, and the template it boots by default. */
export const MACOS_PRESET = "macos-coder";
export const DEFAULT_MACOS_IMAGE = "amika-macos-coder";

export interface RuntimeChange {
  enable: readonly RuntimeName[];
  disable: readonly RuntimeName[];
}

/**
 * `contents` with `change` applied, and what changed, in words; no steps
 * when the file already says it. Turning on Lume also adds its
 * `storage_dir` (`lumeStorageDir`) and the `macos-coder` preset, unless the
 * file has them.
 */
export function updateRuntimes(
  contents: string,
  change: RuntimeChange,
  lumeStorageDir: string,
): { contents: string; steps: string[] } {
  const lines = contents.replace(/\s+$/, "").split("\n");
  const steps: string[] = [];
  const header = (name: RuntimeName) =>
    lines.findIndex((line) =>
      new RegExp(`^\\s*\\[\\s*runtimes\\.${name}\\s*\\]`).test(line),
    );
  const hasTables = RUNTIME_NAMES.some((name) => header(name) !== -1);
  /** The line setting `key` in the table whose header is at `at`, or -1. */
  const keyLine = (at: number, key: string) => {
    let end = at + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) {
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[end])) return end;
      end++;
    }
    return -1;
  };
  /** `enabled` in table `name`: true, false, or undefined (a listed table is on). */
  const enabledLine = (at: number) => keyLine(at, "enabled");
  const isOn = (name: RuntimeName) => {
    const at = header(name);
    // With no [runtimes] tables, only smol is on.
    if (at === -1) return !hasTables && name === "smol";
    const flag = enabledLine(at);
    return flag === -1 || !/=\s*false\b/.test(lines[flag]);
  };
  const setFlag = (name: RuntimeName, on: boolean) => {
    const at = header(name);
    const flag = enabledLine(at);
    if (flag !== -1) lines[flag] = `enabled = ${on}`;
    else if (!on) lines.splice(at + 1, 0, "enabled = false");
  };
  const append = (block: string[]) => lines.push("", ...block);

  // Listing one runtime turns off every runtime not listed, so a file that
  // left smol on by having no tables lists it first.
  if (!hasTables && change.enable.some((name) => name !== "smol")) {
    if (!change.disable.includes("smol")) append(["[runtimes.smol]"]);
  }
  for (const name of change.enable) {
    if (isOn(name)) continue;
    if (header(name) !== -1) {
      setFlag(name, true);
      // A turned-off Lume table needs no storage_dir, but a turned-on one
      // does, so turning it back on adds one.
      const at = header(name);
      if (name === "lume" && keyLine(at, "storage_dir") === -1) {
        lines.splice(
          at + 1,
          0,
          `storage_dir = ${JSON.stringify(lumeStorageDir)}`,
        );
      }
    } else if (name === "lume") {
      append([
        "[runtimes.lume]",
        `storage_dir = ${JSON.stringify(lumeStorageDir)}`,
      ]);
    } else append([`[runtimes.${name}]`]);
    steps.push(`Turn on ${name}`);
    if (
      name === "lume" &&
      !lines.some((line) =>
        new RegExp(`^\\s*\\[\\s*presets\\.[^\\]]*runtimes\\.lume\\s*\\]`).test(
          line,
        ),
      )
    ) {
      append([
        `[presets.${tomlKey(MACOS_PRESET)}.runtimes.lume]`,
        `image = ${JSON.stringify(DEFAULT_MACOS_IMAGE)}`,
      ]);
      steps.push(
        `Add preset ${MACOS_PRESET} on lume, booting template ${DEFAULT_MACOS_IMAGE}`,
      );
    }
  }
  for (const name of change.disable) {
    if (!isOn(name)) continue;
    if (header(name) === -1) append([`[runtimes.${name}]`, "enabled = false"]);
    else setFlag(name, false);
    steps.push(`Turn off ${name}`);
  }
  return {
    contents: steps.length ? `${lines.join("\n")}\n` : contents,
    steps,
  };
}

/**
 * Refuse to turn off a runtime that still has rigs, naming them: hostd never
 * stops a rig to change its config. `machines` is the machine index's
 * entries, each rig with the runtime that owns it.
 */
export function refuseTurningOffWithRigs(
  disable: readonly RuntimeName[],
  machines: readonly (readonly [string, RuntimeName])[],
): void {
  for (const runtime of disable) {
    const rigs = machines.filter(([, owner]) => owner === runtime);
    if (rigs.length > 0) {
      throw new ConfigError(
        `${runtime} has ${rigs.length} rig${rigs.length === 1 ? "" : "s"} (${rigs.map(([name]) => name).join(", ")}). Delete ${rigs.length === 1 ? "it" : "them"}, then try again.`,
      );
    }
  }
}
