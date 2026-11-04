/** Cover the runtime and preset rules of spec 026, and the capabilities report. */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import {
  capabilitiesOf,
  checkRuntimesSupported,
  presetImages,
} from "./runtimes.js";

function runtimesOf(contents: string) {
  return resolveConfig({
    file: { path: "/etc/amika-hostd/config.toml", contents },
  }).runtimes;
}

const SIZES = `
[sizes.m]
vcpus = 4
memory_gib = 8
disk_gib = 20
`;

const LUME = `
[runtimes.lume]
storage_dir = "/Volumes/Data/amika-lume"
`;

/** A machine whose facts no report should need. */
const noMachine = () => {
  throw new Error("read the machine's facts with bare_metal off");
};

const MACHINE = {
  os: "macos" as const,
  vcpus: 10,
  memoryGib: 32,
  diskGib: 460.4,
  sshUser: "jakub",
};

describe("resolveRuntimes", () => {
  it("turns on smol only when the file has no [runtimes] table", () => {
    expect(Object.keys(runtimesOf(SIZES).runtimes)).toEqual(["smol"]);
  });

  it("turns on each listed runtime, and none that is off or not listed", () => {
    const config = runtimesOf(`
[runtimes.smol]
enabled = false
${LUME}`);
    expect(Object.keys(config.runtimes)).toEqual(["lume"]);
  });

  it("refuses a runtime it has no code for", () => {
    expect(() => runtimesOf("[runtimes.docker]")).toThrow(
      /runtimes\.docker: unknown runtime "docker"/,
    );
  });

  describe("bare_metal", () => {
    it("turns on alone, leaving smol off", () => {
      expect(
        Object.keys(runtimesOf(`${SIZES}[runtimes.bare_metal]`).runtimes),
      ).toEqual(["bare_metal"]);
    });

    it("runs beside smol and lume, with no sizes of its own", () => {
      const config = runtimesOf(
        `${SIZES}[runtimes.smol]\n${LUME}[runtimes.bare_metal]\n`,
      );
      expect(Object.keys(config.runtimes)).toEqual([
        "smol",
        "lume",
        "bare_metal",
      ]);
      expect(config.runtimes.bare_metal).toEqual({
        name: "bare_metal",
        maxRunning: undefined,
        sizes: {},
        storageDir: undefined,
      });
    });

    it.each([
      "[runtimes.bare_metal]\nmax_running = 1",
      "[runtimes.bare_metal.sizes.m]\nvcpus = 1\nmemory_gib = 1\ndisk_gib = 1",
    ])("takes only enabled: %j", (contents) => {
      expect(() => runtimesOf(contents)).toThrow(
        "runtimes.bare_metal takes only `enabled`",
      );
    });

    it.each([
      `[runtimes.bare_metal]\n[presets.coder.runtimes.bare_metal]\nimage = "x"`,
      `[runtimes.smol]\n[presets.coder]\ndefault_runtime = "bare_metal"\n[presets.coder.runtimes.smol]\nimage = "x"`,
    ])("is no preset's runtime: %j", (contents) => {
      expect(() => runtimesOf(contents)).toThrow(
        "bare_metal boots no image, so no preset runs on it",
      );
    });
  });

  it("needs an absolute storage_dir for lume, and only for lume", () => {
    expect(() => runtimesOf("[runtimes.lume]")).toThrow(
      /runtimes\.lume\.storage_dir must be set/,
    );
    expect(() =>
      runtimesOf(`[runtimes.lume]\nstorage_dir = "amika-lume"`),
    ).toThrow(/runtimes\.lume\.storage_dir must be set to an absolute path/);
    expect(() =>
      runtimesOf(`[runtimes.smol]\nstorage_dir = "/srv/smol"`),
    ).toThrow(/runtimes\.smol\.storage_dir is only for lume/);
  });

  describe("sizes", () => {
    it("gives a runtime with no list of its own the default list", () => {
      expect(runtimesOf(SIZES).runtimes.smol?.sizes).toEqual({
        m: { vcpus: 4, memoryGib: 8, diskGib: 20, diskGrowOnly: false },
      });
    });

    it("replaces the default list with a runtime's own, and does not merge them", () => {
      const config = runtimesOf(`${SIZES}
[runtimes.smol]
${LUME}
[runtimes.lume.sizes.l]
vcpus = 8
memory_gib = 16
disk_gib = 80
`);
      expect(config.runtimes.lume?.sizes).toEqual({
        l: { vcpus: 8, memoryGib: 16, diskGib: 80, diskGrowOnly: false },
      });
      expect(Object.keys(config.runtimes.smol?.sizes ?? {})).toEqual(["m"]);
    });
  });

  describe("max_running", () => {
    it("has no limit on smol unless one is set", () => {
      expect(runtimesOf("[runtimes.smol]").runtimes.smol?.maxRunning).toBe(
        undefined,
      );
      expect(
        runtimesOf("[runtimes.smol]\nmax_running = 4").runtimes.smol
          ?.maxRunning,
      ).toBe(4);
    });

    it.each([
      [undefined, 2, false],
      [1, 1, false],
      [2, 2, false],
      [3, 2, true],
    ])("limits lume set to %s to %s", (setting, limit, warned) => {
      const config = runtimesOf(
        setting === undefined ? LUME : `${LUME}max_running = ${setting}\n`,
      );
      expect(config.runtimes.lume?.maxRunning).toBe(limit);
      expect(config.warnings.some((w) => w.includes("max_running"))).toBe(
        warned,
      );
    });
  });

  describe("presets", () => {
    it("makes a preset's one runtime its default", () => {
      const config = runtimesOf(`${LUME}
[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`);
      expect(config.presets["macos-coder"]).toEqual({
        os: "macos",
        defaultRuntime: "lume",
        images: { lume: "amika-macos-coder" },
      });
    });

    it("needs default_runtime with two or more runtimes", () => {
      expect(() =>
        runtimesOf(`
[runtimes.smol]
[presets.coder.runtimes.smol]
image = "ghcr.io/x:y"
[presets.coder.runtimes.lume]
image = "amika-macos-coder"
`),
      ).toThrow(/presets\.coder\.default_runtime is required/);
    });

    it("refuses runtimes with different guest OSes, also when one is off", () => {
      expect(() =>
        runtimesOf(`
[runtimes.smol]
[presets.coder]
default_runtime = "smol"
[presets.coder.runtimes.smol]
image = "ghcr.io/x:y"
[presets.coder.runtimes.lume]
image = "amika-macos-coder"
`),
      ).toThrow(/different guest OSes \(linux, macos\)/);
    });

    it("refuses a default_runtime that is not one of the preset's runtimes", () => {
      expect(() =>
        runtimesOf(`
[presets.coder]
default_runtime = "lume"
[presets.coder.runtimes.smol]
image = "ghcr.io/x:y"
`),
      ).toThrow(
        /default_runtime is lume, which is not one of the preset's runtimes/,
      );
    });

    it("ignores a preset with no runtime on, with a warning", () => {
      const config = runtimesOf(`
[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`);
      expect(config.presets).toEqual({});
      expect(config.warnings).toEqual([
        "presets.macos-coder is ignored: none of its runtimes is on",
      ]);
    });

    it("refuses a preset with no runtimes", () => {
      expect(() => runtimesOf("[presets.coder]")).toThrow(
        /presets\.coder has no runtimes/,
      );
    });

    it("lists each preset's image for one runtime", () => {
      const config = runtimesOf(`
[runtimes.smol]
${LUME}
[presets.coder.runtimes.smol]
image = "ghcr.io/x:y"
[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`);
      expect(presetImages(config, "smol")).toEqual({ coder: "ghcr.io/x:y" });
      expect(presetImages(config, "lume")).toEqual({
        "macos-coder": "amika-macos-coder",
      });
    });
  });
});

describe("capabilitiesOf", () => {
  it("reports each runtime and preset, with resolved sizes and limits and no images", () => {
    const config = runtimesOf(`${SIZES}
[runtimes.smol]
max_running = 4
${LUME}
[runtimes.lume.sizes.m]
vcpus = 4
memory_gib = 8
disk_gib = 80
[presets.coder.runtimes.smol]
image = "ghcr.io/gofixpoint/amika-coder:tag"
[presets.macos-coder.runtimes.lume]
image = "amika-macos-coder"
`);
    expect(capabilitiesOf(config, "arm64", noMachine)).toEqual({
      runtimes: {
        smol: {
          kind: "vm",
          os: "linux",
          arch: "arm64",
          max_running: 4,
          snapshots: true,
          sizes: { m: { vcpus: 4, memory_gib: 8, disk_gib: 20 } },
        },
        lume: {
          kind: "vm",
          os: "macos",
          arch: "arm64",
          max_running: 2,
          snapshots: false,
          sizes: { m: { vcpus: 4, memory_gib: 8, disk_gib: 80 } },
        },
      },
      presets: {
        coder: { os: "linux", default_runtime: "smol", runtimes: ["smol"] },
        "macos-coder": {
          os: "macos",
          default_runtime: "lume",
          runtimes: ["lume"],
        },
      },
    });
  });

  it("leaves out a limit that is not set", () => {
    expect(
      capabilitiesOf(runtimesOf(SIZES), "x64", noMachine).runtimes.smol,
    ).not.toHaveProperty("max_running");
  });

  it("reports bare_metal as this machine, with no limit, sizes or snapshots", () => {
    const report = capabilitiesOf(
      runtimesOf(`${SIZES}[runtimes.smol]\n[runtimes.bare_metal]\n`),
      "arm64",
      () => MACHINE,
    );
    expect(report.runtimes.bare_metal).toEqual({
      kind: "host",
      os: "macos",
      arch: "arm64",
      snapshots: false,
      sizes: {},
      resources: { vcpus: 10, memory_gib: 32, disk_gib: 460.4 },
      ssh_user: "jakub",
    });
    expect(report.runtimes.smol.os).toBe("linux");
  });
});

describe("checkRuntimesSupported", () => {
  it("refuses lume where the machine cannot run it", () => {
    const config = runtimesOf(`[runtimes.smol]\n${LUME}`);
    expect(() =>
      checkRuntimesSupported(config, ["smol", "lume"]),
    ).not.toThrow();
    expect(() => checkRuntimesSupported(config, ["smol"])).toThrow(
      "runtime lume cannot run on this machine: it needs macOS on Apple Silicon; turn it off in [runtimes.lume]",
    );
  });
});
