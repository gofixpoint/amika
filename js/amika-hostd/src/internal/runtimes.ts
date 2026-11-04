/**
 * The runtimes a host runs rigs on, the presets it offers on them, and the
 * capabilities report built from both (spec 026, "hostd config").
 *
 * `resolveRuntimes` turns the TOML tables into checked settings, and
 * `capabilitiesOf` turns those into what hostd tells Amika. Both are pure, so
 * startup, reload and `capabilities update` check a config the same way.
 */
import os from "node:os";
import path from "node:path";
import { ConfigError, type HostSize } from "./config.js";

/** The tools hostd can run rigs with. */
export const RUNTIME_NAMES = ["smol", "lume"] as const;
export type RuntimeName = (typeof RUNTIME_NAMES)[number];

export type GuestOs = "linux" | "macos";

/** What each runtime is, whatever the config says. */
export const RUNTIME_KINDS: Record<
  RuntimeName,
  { kind: "vm" | "container"; os: GuestOs; snapshots: boolean }
> = {
  smol: { kind: "vm", os: "linux", snapshots: true },
  lume: { kind: "vm", os: "macos", snapshots: false },
};

/**
 * Apple's macOS license allows two macOS VMs on each Mac, and
 * Virtualization.framework refuses a third.
 */
export const LUME_MAX_RUNNING = 2;

export interface RuntimeSettings {
  name: RuntimeName;
  /** The effective limit on running rigs; undefined is no limit. */
  maxRunning?: number;
  /** The resolved size list: the runtime's own, else the default list. */
  sizes: Record<string, HostSize>;
  /** Lume only: where hostd keeps its VMs, apart from other Lume VMs. */
  storageDir?: string;
}

export interface PresetSettings {
  os: GuestOs;
  defaultRuntime: RuntimeName;
  /** The image for each runtime that is on, in that runtime's format. */
  images: Partial<Record<RuntimeName, string>>;
}

export interface RuntimeConfig {
  /** The runtimes that are on. */
  runtimes: Partial<Record<RuntimeName, RuntimeSettings>>;
  /** The presets with at least one runtime that is on. */
  presets: Record<string, PresetSettings>;
  /** Entries hostd ignores, for the log. */
  warnings: string[];
}

/** `[runtimes.<name>]`, as the TOML schema parsed it. */
export interface RuntimeTable {
  enabled?: boolean;
  max_running?: number;
  storage_dir?: string;
  sizes?: Record<string, HostSize>;
}

/** `[presets.<name>]`, as the TOML schema parsed it. */
export interface PresetTable {
  default_runtime?: string;
  runtimes?: Record<string, { image: string }>;
}

/**
 * Check the runtime and preset tables, and resolve the size lists and
 * limits. With no `[runtimes]` table, only `smol` is on, as before runtimes
 * existed.
 */
export function resolveRuntimes({
  runtimes: runtimeTables,
  presets: presetTables = {},
  sizes,
}: {
  runtimes?: Record<string, RuntimeTable>;
  presets?: Record<string, PresetTable>;
  sizes: Record<string, HostSize>;
}): RuntimeConfig {
  const warnings: string[] = [];
  const runtimes: RuntimeConfig["runtimes"] = {};
  for (const [name, table] of Object.entries(
    runtimeTables ?? { smol: { enabled: true } },
  )) {
    const runtime = runtimeName(name, `runtimes.${name}`);
    if (table.storage_dir !== undefined && runtime !== "lume") {
      throw new ConfigError(`runtimes.${name}.storage_dir is only for lume`);
    }
    if (table.enabled === false) continue;
    runtimes[runtime] = {
      name: runtime,
      maxRunning: maxRunning(runtime, table.max_running, warnings),
      sizes: table.sizes ?? sizes,
      storageDir: table.storage_dir,
    };
    if (
      runtime === "lume" &&
      (table.storage_dir === undefined || !path.isAbsolute(table.storage_dir))
    ) {
      throw new ConfigError(
        "runtimes.lume.storage_dir must be set to an absolute path",
      );
    }
  }

  const presets: RuntimeConfig["presets"] = {};
  for (const [name, table] of Object.entries(presetTables)) {
    const entries = Object.entries(table.runtimes ?? {}).map(
      ([runtime, entry]) =>
        [
          runtimeName(runtime, `presets.${name}.runtimes.${runtime}`),
          entry,
        ] as const,
    );
    if (entries.length === 0) {
      throw new ConfigError(`presets.${name} has no runtimes`);
    }
    const defaultRuntime = presetDefault(name, table, entries);
    // A preset promises one OS, also through runtimes that are off.
    const oses = new Set(entries.map(([runtime]) => RUNTIME_KINDS[runtime].os));
    if (oses.size > 1) {
      throw new ConfigError(
        `presets.${name} has runtimes with different guest OSes (${[...oses].join(", ")}); a preset must have one OS`,
      );
    }
    if (entries.every(([runtime]) => runtimes[runtime] === undefined)) {
      warnings.push(`presets.${name} is ignored: none of its runtimes is on`);
      continue;
    }
    if (runtimes[defaultRuntime] === undefined) {
      throw new ConfigError(
        `presets.${name} has default runtime ${defaultRuntime}, which is off`,
      );
    }
    const images: PresetSettings["images"] = {};
    for (const [runtime, entry] of entries) {
      if (runtimes[runtime] === undefined) {
        warnings.push(
          `presets.${name}.runtimes.${runtime} is ignored: runtime ${runtime} is off`,
        );
        continue;
      }
      images[runtime] = entry.image;
    }
    presets[name] = { os: [...oses][0], defaultRuntime, images };
  }
  return { runtimes, presets, warnings };
}

/** What hostd tells Amika it can run (spec 026, "Capabilities"). */
export interface Capabilities {
  runtimes: Record<
    string,
    {
      kind: "vm" | "container";
      os: GuestOs;
      arch: string;
      max_running?: number;
      snapshots: boolean;
      sizes: Record<
        string,
        {
          vcpus: number;
          memory_gib: number;
          disk_gib: number;
          disk_grow_only?: boolean;
        }
      >;
    }
  >;
  presets: Record<
    string,
    { os: GuestOs; default_runtime: RuntimeName; runtimes: RuntimeName[] }
  >;
}

/**
 * The report as Amika's hosts API takes it: the same, with each size in the
 * shape of the API's `sizes` (`HostSize`).
 */
export interface ApiCapabilities {
  runtimes: Record<
    string,
    Omit<Capabilities["runtimes"][string], "sizes"> & {
      sizes: Record<string, HostSize>;
    }
  >;
  presets: Capabilities["presets"];
}

export function apiCapabilitiesOf(
  config: RuntimeConfig,
  arch: string,
): ApiCapabilities {
  const report = capabilitiesOf(config, arch);
  return {
    runtimes: Object.fromEntries(
      Object.entries(report.runtimes).map(([name, runtime]) => [
        name,
        { ...runtime, sizes: config.runtimes[name as RuntimeName]!.sizes },
      ]),
    ),
    presets: report.presets,
  };
}

/** The report for `config` on a host of `arch`. Images stay on the host. */
export function capabilitiesOf(
  config: RuntimeConfig,
  arch: string,
): Capabilities {
  return {
    runtimes: Object.fromEntries(
      Object.values(config.runtimes).map((runtime) => [
        runtime.name,
        {
          ...RUNTIME_KINDS[runtime.name],
          arch,
          ...(runtime.maxRunning === undefined
            ? {}
            : { max_running: runtime.maxRunning }),
          sizes: Object.fromEntries(
            Object.entries(runtime.sizes).map(([name, size]) => [
              name,
              {
                vcpus: size.vcpus,
                memory_gib: size.memoryGib,
                disk_gib: size.diskGib,
                ...(size.diskGrowOnly ? { disk_grow_only: true } : {}),
              },
            ]),
          ),
        },
      ]),
    ),
    presets: Object.fromEntries(
      Object.entries(config.presets).map(([name, preset]) => [
        name,
        {
          os: preset.os,
          default_runtime: preset.defaultRuntime,
          runtimes: Object.keys(preset.images) as RuntimeName[],
        },
      ]),
    ),
  };
}

function runtimeName(name: string, setting: string): RuntimeName {
  if ((RUNTIME_NAMES as readonly string[]).includes(name)) {
    return name as RuntimeName;
  }
  throw new ConfigError(
    `${setting}: unknown runtime ${JSON.stringify(name)}; use ${RUNTIME_NAMES.join(" or ")}`,
  );
}

/** Lume's limit is the smaller of the setting and 2, also with no setting. */
function maxRunning(
  runtime: RuntimeName,
  setting: number | undefined,
  warnings: string[],
): number | undefined {
  if (runtime !== "lume") return setting;
  if (setting !== undefined && setting > LUME_MAX_RUNNING) {
    warnings.push(
      `runtimes.lume.max_running is ${setting}; macOS runs at most ${LUME_MAX_RUNNING} VMs, so hostd uses ${LUME_MAX_RUNNING}`,
    );
  }
  return Math.min(setting ?? LUME_MAX_RUNNING, LUME_MAX_RUNNING);
}

/** `default_runtime` is required with two or more runtimes. */
function presetDefault(
  name: string,
  table: PresetTable,
  entries: readonly (readonly [RuntimeName, unknown])[],
): RuntimeName {
  const listed = entries.map(([runtime]) => runtime);
  if (table.default_runtime === undefined) {
    if (listed.length === 1) return listed[0];
    throw new ConfigError(
      `presets.${name}.default_runtime is required: the preset has runtimes ${listed.join(", ")}`,
    );
  }
  const runtime = runtimeName(
    table.default_runtime,
    `presets.${name}.default_runtime`,
  );
  if (!listed.includes(runtime)) {
    throw new ConfigError(
      `presets.${name}.default_runtime is ${runtime}, which is not one of the preset's runtimes (${listed.join(", ")})`,
    );
  }
  return runtime;
}

/** Each preset's image on `runtime`, keyed by preset name. */
export function presetImages(
  config: RuntimeConfig,
  runtime: RuntimeName,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.presets).flatMap(([name, preset]) => {
      const image = preset.images[runtime];
      return image === undefined ? [] : [[name, image]];
    }),
  );
}

/** Refuse a runtime that is on but that this machine cannot run. */
export function checkRuntimesSupported(
  config: RuntimeConfig,
  supported: readonly RuntimeName[],
): void {
  for (const name of Object.keys(config.runtimes) as RuntimeName[]) {
    if (!supported.includes(name)) {
      throw new ConfigError(
        `runtime ${name} cannot run on this machine${name === "lume" ? ": it needs macOS on Apple Silicon" : ""}; turn it off in [runtimes.${name}]`,
      );
    }
  }
}

/** This machine's CPU architecture, in Go's names as Amika's releases use. */
export function hostArch(arch: string = os.arch()): string {
  return arch === "x64" ? "amd64" : arch;
}
