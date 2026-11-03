/**
 * The config change `amika-hostd capabilities update` makes (spec 026,
 * "`amika-hostd capabilities`"): turn runtimes on or off in
 * `[runtimes.*]`, keeping everything else in `config.toml` as it is.
 */
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
  /** `enabled` in table `name`: true, false, or undefined (a listed table is on). */
  const enabledLine = (at: number) => {
    let end = at + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) {
      if (/^\s*enabled\s*=/.test(lines[end])) return end;
      end++;
    }
    return -1;
  };
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
    if (header(name) !== -1) setFlag(name, true);
    else if (name === "lume") {
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
