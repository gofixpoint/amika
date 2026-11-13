import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostPlatformFor } from "../platforms/index.js";
import { DaemonError } from "./daemon.js";
import {
  buildMacosImage,
  buildMacosImagesInBackground,
  runToStderr,
  unattendedPreset,
  findMacosImageFiles,
  installLume,
  MACOS_BASE_VM,
  macosRestoreImageDir,
  missingMacosImages,
  progressFilter,
  runShowingProgress,
  type MacosImageDeps,
} from "./lume-setup.js";

const LUME = "/home/op/.local/bin/lume";
const FILES = {
  buildScript: "/opt/hostd/macos-image/build.sh",
  versionsEnv: "/opt/hostd/macos-image/versions.env",
};

/**
 * A Mac whose Lume storage has `vms`; each command exits with `exit`. With
 * `download`, `lume create --ipsw latest` leaves a restore image in TMPDIR,
 * as Lume does.
 */
function mac({ vms = [] as string[], exit = 0, download = false } = {}) {
  const out: string[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "amika-hostd-lume-"));
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/op",
    TMPDIR: path.join(root, "tmp"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  };
  mkdirSync(env.TMPDIR);
  const run = vi.fn(
    async (
      _command: string,
      args: readonly string[],
      _env: NodeJS.ProcessEnv,
    ) => {
      if (download && args[0] === "create" && args[2] === "latest") {
        writeFileSync(path.join(env.TMPDIR, "latest.ipsw"), "ipsw");
      }
      return exit as number | null;
    },
  );
  const deps = {
    env,
    out: (line: string) => out.push(line),
    platform: hostPlatformFor("darwin", { arch: () => "arm64" } as never),
    findLume: () => LUME,
    hasLumeVm: vi.fn(async (_lume: string, name: string) => vms.includes(name)),
    run,
    imageFiles: () => FILES,
    macosVersion: () => "26.6.2",
    lumeVersion: async () => "0.6.1",
    installAmikad: vi.fn(async () => "/data/amikad/0.3.0/amikad"),
  } satisfies MacosImageDeps;
  return { deps, out, run };
}

describe("missingMacosImages", () => {
  it("names the templates Lume does not have, once each", async () => {
    const { deps } = mac({ vms: ["amika-macos-coder"] });
    expect(
      await missingMacosImages(
        ["amika-macos-coder", "my-image", "my-image"],
        deps,
      ),
    ).toEqual(["my-image"]);
  });

  it("names them all when Lume is not installed", async () => {
    const { deps } = mac();
    expect(
      await missingMacosImages(["amika-macos-coder"], {
        ...deps,
        findLume: () => undefined,
      }),
    ).toEqual(["amika-macos-coder"]);
    expect(deps.hasLumeVm).not.toHaveBeenCalled();
  });
});

describe("Lume failures", () => {
  it("reports one from checking an image as an error the CLI prints", async () => {
    const { deps } = mac();
    const cause = new Error("lume get failed (exit 1): permission denied");
    const failing = {
      ...deps,
      hasLumeVm: vi.fn(async () => {
        throw cause;
      }),
    };
    const error = await missingMacosImages(
      ["amika-macos-coder"],
      failing,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DaemonError);
    expect((error as Error).message).toBe(
      "Checking Lume for amika-macos-coder failed: lume get failed (exit 1): permission denied",
    );
    expect((error as Error).cause).toBe(cause);
  });

  it("reports a build step that will not start", async () => {
    const { deps } = mac();
    const failing = {
      ...deps,
      run: vi.fn(async () => {
        throw new Error("spawn /bin/bash ENOENT");
      }),
    };
    await expect(
      buildMacosImage("amika-macos-coder", {}, failing),
    ).rejects.toThrow(
      new DaemonError("Starting lume failed: spawn /bin/bash ENOENT"),
    );
  });
});

describe("buildMacosImage", () => {
  it("makes the base VM, then runs build.sh with hostd's amikad and pins", async () => {
    const { deps, run } = mac();
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [
        LUME,
        [
          "create",
          "--ipsw",
          "latest",
          "--disk-size",
          "100GB",
          "--unattended",
          "tahoe",
          MACOS_BASE_VM,
        ],
      ],
      ["/bin/bash", [FILES.buildScript, MACOS_BASE_VM, "amika-macos-coder"]],
    ]);
    const env = run.mock.calls[1][2];
    expect(env).toMatchObject({
      AMIKAD_BIN: "/data/amikad/0.3.0/amikad",
      VERSIONS_ENV: FILES.versionsEnv,
      // build.sh parses Lume's JSON with it, needing no python3.
      NODE: process.execPath,
      LUME_TELEMETRY_ENABLED: "false",
    });
    // `lume create` too, which runs before the daemon turns telemetry off.
    expect(run.mock.calls[0][2]).toMatchObject({
      LUME_TELEMETRY_ENABLED: "false",
    });
    // build.sh calls `lume` by name.
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(LUME));
  });

  it("keeps the restore image Lume downloaded, for this Mac's macOS version", async () => {
    const { deps } = mac({ download: true });
    const dir = macosRestoreImageDir(deps.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "restore-macos15.ipsw"), "old");
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(existsSync(path.join(deps.env.TMPDIR, "latest.ipsw"))).toBe(false);
    // The macOS 15 image is not used again on this macOS 26 Mac.
    expect(readdirSync(dir)).toEqual(["restore-macos26.ipsw"]);
  });

  it("keeps the restore image after a failed create, for the retry", async () => {
    const { deps } = mac({ download: true, exit: 1 });
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow();
    expect(
      existsSync(
        path.join(macosRestoreImageDir(deps.env), "restore-macos26.ipsw"),
      ),
    ).toBe(true);
  });

  it("leaves a restore image in TMPDIR that this create did not write", async () => {
    const { deps } = mac({ exit: 1 });
    const old = path.join(deps.env.TMPDIR, "latest.ipsw");
    writeFileSync(old, "old");
    const yesterday = new Date(Date.now() - 86_400_000);
    utimesSync(old, yesterday, yesterday);
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow();
    expect(existsSync(old)).toBe(true);
    expect(existsSync(macosRestoreImageDir(deps.env))).toBe(false);
  });

  it("makes the base VM from the kept restore image for this macOS version", async () => {
    const { deps, run } = mac();
    const kept = path.join(
      macosRestoreImageDir(deps.env),
      "restore-macos26.ipsw",
    );
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, "ipsw");
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(run.mock.calls[0][1]).toEqual([
      "create",
      "--ipsw",
      kept,
      "--disk-size",
      "100GB",
      "--unattended",
      "tahoe",
      MACOS_BASE_VM,
    ]);
    expect(existsSync(kept)).toBe(true);
  });

  it("downloads again when the kept restore image is another macOS version", async () => {
    const { deps, run } = mac();
    const dir = macosRestoreImageDir(deps.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "restore-macos15.ipsw"), "old");
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(run.mock.calls[0][1]).toContain("latest");
  });

  it("reuses a base VM that is already there", async () => {
    const { deps, run } = mac({ vms: [MACOS_BASE_VM] });
    await buildMacosImage("amika-macos-coder", {}, deps);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe("/bin/bash");
  });

  it("installs from the restore image AMIKA_HOSTD_MACOS_IPSW names, and keeps no copy", async () => {
    const { deps, run } = mac({ download: true });
    const kept = path.join(
      macosRestoreImageDir(deps.env),
      "restore-macos26.ipsw",
    );
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, "ipsw");
    await buildMacosImage(
      "amika-macos-coder",
      {},
      {
        ...deps,
        env: { ...deps.env, AMIKA_HOSTD_MACOS_IPSW: "/srv/macos-26.5.2.ipsw" },
      },
    );
    expect(run.mock.calls[0][1]).toContain("/srv/macos-26.5.2.ipsw");
    expect(readdirSync(path.dirname(kept))).toEqual(["restore-macos26.ipsw"]);
  });

  it("stops at a failed step, naming it", async () => {
    const { deps, run } = mac({ exit: 1 });
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow(/lume create.*failed \(exit 1\)/);
    expect(run).toHaveBeenCalledOnce();
    expect(deps.installAmikad).not.toHaveBeenCalled();
  });

  it("refuses without Lume or without the build files", async () => {
    const { deps } = mac();
    await expect(
      buildMacosImage("x", {}, { ...deps, findLume: () => undefined }),
    ).rejects.toThrow(DaemonError);
    await expect(
      buildMacosImage("x", {}, { ...deps, imageFiles: () => undefined }),
    ).rejects.toThrow(/no macOS image build files/);
  });
});

describe("findMacosImageFiles", () => {
  it("finds this checkout's build.sh and version pins from the source", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    expect(findMacosImageFiles(import.meta.dirname)).toEqual({
      buildScript: path.join(repo, "macos-image", "build.sh"),
      versionsEnv: path.join(repo, "sandbox-image", "versions.env"),
    });
  });

  it("finds nothing where neither layout is", () => {
    expect(findMacosImageFiles("/nonexistent/a/b/c/d")).toBeUndefined();
  });
});

describe("installLume", () => {
  it("runs the pinned installer with Lume's telemetry off", async () => {
    // The installer runs the new binary once, which records an install
    // event unless the opt-out is set.
    const run = vi.fn(async () => 1 as number | null);
    await expect(
      installLume({ env: { HOME: "/home/op" }, out: () => {}, run }),
    ).rejects.toThrow(DaemonError);
    expect(run.mock.calls[0]).toEqual([
      "/bin/bash",
      [
        "-c",
        expect.stringContaining(
          "https://raw.githubusercontent.com/trycua/cua/lume-v0.6.1/",
        ),
      ],
      expect.objectContaining({
        LUME_VERSION: "0.6.1",
        LUME_TELEMETRY_ENABLED: "false",
      }),
    ]);
  });
});

describe("buildMacosImagesInBackground", () => {
  /** A Mac missing `missing`, whose build of each runs `build`. */
  function background(
    missing: string[],
    build: (template: string) => Promise<void> = async () => {},
  ) {
    const { deps, out } = mac({
      vms: ["amika-macos-coder", "other"].filter((t) => !missing.includes(t)),
    });
    const err: string[] = [];
    const building = new Set<string>();
    const seen: string[][] = [];
    const options = {
      ...deps,
      templates: ["amika-macos-coder", "other"],
      config: {},
      err: (line: string) => err.push(line),
      building,
      build: vi.fn(async (template: string) => {
        seen.push([...building]);
        await build(template);
      }),
    };
    return { options, out, err, building, seen };
  }

  it("builds only the missing templates, holding each as building meanwhile", async () => {
    const { options, out, building, seen } = background(["other"]);
    await buildMacosImagesInBackground(options);
    expect(options.build).toHaveBeenCalledOnce();
    expect(options.build.mock.calls[0][0]).toBe("other");
    expect(seen).toEqual([["other"]]);
    expect(building.size).toBe(0);
    expect(out.at(-1)).toMatch(/^Built the macOS image other for Lume rigs/);
  });

  it("logs a failed build, names the retry, and goes on", async () => {
    const { options, err, building } = background(
      ["amika-macos-coder", "other"],
      async (template) => {
        if (template === "amika-macos-coder") {
          throw new DaemonError("`lume create` failed (exit 1)");
        }
      },
    );
    await buildMacosImagesInBackground(options);
    expect(options.build).toHaveBeenCalledTimes(2);
    expect(err).toEqual([
      "amika-hostd: could not build the macOS image amika-macos-coder: `lume create` failed (exit 1); Lume rigs of it fail until it is built, and the next `amika-hostd up` or `amika-hostd reload` tries again",
    ]);
    expect(building.size).toBe(0);
  });

  it("stops quietly once the daemon stops", async () => {
    const stopping = new AbortController();
    const { options, err } = background(
      ["amika-macos-coder", "other"],
      async () => {
        stopping.abort();
        throw new DaemonError("Starting lume failed: aborted");
      },
    );
    await buildMacosImagesInBackground({ ...options, signal: stopping.signal });
    expect(options.build).toHaveBeenCalledOnce();
    expect(err).toEqual([]);
  });

  it("holds every template while Lume is asked which it has, then releases those it has", async () => {
    const { options, building } = background(["other"]);
    let answer: () => void = () => {};
    const asked = new Promise<void>((resolve) => (answer = resolve));
    const held: string[][] = [];
    const running = buildMacosImagesInBackground({
      ...options,
      hasLumeVm: async (_lume: string, name: string) => {
        held.push([...building]);
        await asked;
        return name === "amika-macos-coder";
      },
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // Before Lume has answered, a create of either is refused with a 503.
    expect(held[0]).toEqual(["amika-macos-coder", "other"]);
    answer();
    await running;
    // Only the missing one was held through its build.
    expect(options.build).toHaveBeenCalledOnce();
    expect(building.size).toBe(0);
  });

  it("stops checking Lume once the daemon stops, quietly, and releases every template", async () => {
    const stopping = new AbortController();
    const { options, err, building } = background([]);
    const hasLumeVm = vi.fn(
      (_lume: string, _name: string, signal?: AbortSignal) =>
        new Promise<boolean>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const running = buildMacosImagesInBackground({
      ...options,
      hasLumeVm,
      signal: stopping.signal,
    });
    await vi.waitFor(() => expect(hasLumeVm).toHaveBeenCalledOnce());
    stopping.abort();
    await running;
    // The hung check was cut short, and the next template never checked.
    expect(hasLumeVm).toHaveBeenCalledOnce();
    expect(options.build).not.toHaveBeenCalled();
    expect(err).toEqual([]);
    expect(building.size).toBe(0);
  });

  it("logs Lume failing to say what is missing, and never throws", async () => {
    const { options, err } = background([]);
    await buildMacosImagesInBackground({
      ...options,
      hasLumeVm: async () => {
        throw new Error("lume get failed");
      },
    });
    expect(options.build).not.toHaveBeenCalled();
    expect(err[0]).toMatch(/could not check Lume for its macOS images/);
  });
});

describe("unattendedPreset", () => {
  it.each([
    ["15.3", "sequoia"],
    ["15.7.1", "sequoia"],
    ["26.6.2", "tahoe"],
    // Newer than any preset Lume 0.6.1 has: its newest.
    ["27.1", "tahoe"],
    ["27.2", "tahoe"],
  ])("macOS %s uses %s", (version, preset) => {
    expect(unattendedPreset(version)).toBe(preset);
  });
});

describe("the unattended preset in the build", () => {
  it.each([
    ["15.5", "sequoia"],
    ["26.6.2", "tahoe"],
    ["27.1", "tahoe"],
  ])(
    "on macOS %s, lume create gets --unattended %s",
    async (version, preset) => {
      const { deps, run, out } = mac();
      await buildMacosImage(
        "amika-macos-coder",
        {},
        {
          ...deps,
          macosVersion: () => version,
        },
      );
      expect(run.mock.calls[0][1]).toEqual([
        "create",
        "--ipsw",
        "latest",
        "--disk-size",
        "100GB",
        "--unattended",
        preset,
        MACOS_BASE_VM,
      ]);
      expect(out.join("\n")).toContain(
        `with the ${preset} setup preset (this Mac runs macOS ${version})`,
      );
    },
  );
});

describe("the Lume version", () => {
  it("refuses to build with a Lume other than the one it is tested with", async () => {
    const { deps, run } = mac();
    await expect(
      buildMacosImage(
        "amika-macos-coder",
        {},
        {
          ...deps,
          lumeVersion: async () => "0.7.2",
        },
      ),
    ).rejects.toThrow(
      `${LUME} is Lume 0.7.2, but amika-hostd builds macOS images with Lume 0.6.1; install it with`,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the background build's unavailable templates", () => {
  it("holds every missing template from the start, and frees all of them when cut short", async () => {
    const { deps } = mac({ vms: [] });
    const stopping = new AbortController();
    const building = new Set<string>();
    const seen: string[][] = [];
    await buildMacosImagesInBackground({
      ...deps,
      templates: ["first", "second"],
      config: {},
      err: () => {},
      building,
      signal: stopping.signal,
      build: async () => {
        seen.push([...building]);
        // Stopped during the first build: the second never starts.
        stopping.abort();
        throw new DaemonError("Starting lume failed: aborted");
      },
    });
    expect(seen).toEqual([["first", "second"]]);
    expect(building.size).toBe(0);
  });
});

describe("Amika's secrets", () => {
  const SECRETS = {
    AMIKA_API_KEY: "amk_1",
    AMIKA_HOSTD_API_KEY: "amk_2",
    AMIKA_HOSTD_SECRET_KEY: "s".repeat(64),
  };

  it("never reach Lume's installer", async () => {
    const run = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        _env: NodeJS.ProcessEnv,
      ) => 1 as number | null,
    );
    await installLume({
      env: { HOME: "/home/op", ...SECRETS },
      out: () => {},
      run,
    }).catch(() => {});
    const env = run.mock.calls[0][2];
    expect(env.HOME).toBe("/home/op");
    for (const name of Object.keys(SECRETS))
      expect(env).not.toHaveProperty(name);
  });

  it("never reach the Lume version check", async () => {
    // A stand-in lume that records the environment it gets.
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-lume-"));
    const fake = path.join(dir, "lume");
    writeFileSync(
      fake,
      `#!/bin/sh\nenv > "${path.join(dir, "env")}"\necho 0.6.1\n`,
    );
    chmodSync(fake, 0o755);
    const { deps } = mac();
    const { lumeVersion: _unused, ...withoutFake } = deps;
    await buildMacosImage(
      "amika-macos-coder",
      {},
      {
        ...withoutFake,
        findLume: () => fake,
        env: { ...deps.env, ...SECRETS },
      },
    );
    const seen = readFileSync(path.join(dir, "env"), "utf8");
    for (const name of Object.keys(SECRETS)) {
      expect(seen).not.toMatch(new RegExp(`^${name}=`, "m"));
    }
    expect(seen).toMatch(/^LUME_TELEMETRY_ENABLED=false$/m);
  });

  it("never reach the build's commands", async () => {
    const { deps, run } = mac();
    await buildMacosImage(
      "amika-macos-coder",
      {},
      {
        ...deps,
        env: { ...deps.env, ...SECRETS },
      },
    );
    for (const [, , env] of run.mock.calls) {
      for (const name of Object.keys(SECRETS)) {
        expect(env).not.toHaveProperty(name);
      }
    }
  });
});

describe("buildMacosImage, when making the base VM does not finish", () => {
  /**
   * A Mac where `lume create` exits with `createExit`, leaving the base VM
   * behind unless `leaves` is false; `lume delete` exits with `deleteExit`.
   */
  function failingCreate({
    createExit = 1 as number | null,
    leaves = true,
    deleteExit = 0,
  } = {}) {
    const vms: string[] = [];
    const { deps, out } = mac();
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _env: NodeJS.ProcessEnv,
        _signal?: AbortSignal,
      ) => {
        if (args[0] === "create") {
          if (leaves) vms.push(MACOS_BASE_VM);
          return createExit;
        }
        if (args[0] === "delete") {
          if (deleteExit === 0) vms.splice(vms.indexOf(args[1]), 1);
          return deleteExit;
        }
        return 0;
      },
    );
    const hasLumeVm = vi.fn(
      async (_lume: string, name: string, _signal?: AbortSignal) =>
        vms.includes(name),
    );
    return { deps: { ...deps, run, hasLumeVm }, out, run, vms };
  }

  it("deletes the base VM a failed lume create left, so the next try makes it again", async () => {
    const { deps, run, vms, out } = failingCreate();
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow(
      `\`lume create\` failed (exit 1) making the base VM ${MACOS_BASE_VM}; its output is above. Deleted the half-made base VM ${MACOS_BASE_VM}.`,
    );
    expect(run.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["create", "--ipsw"],
      ["delete", MACOS_BASE_VM],
    ]);
    expect(vms).toEqual([]);
    expect(out).toContain(`Deleting the half-made base VM ${MACOS_BASE_VM}...`);
    expect(deps.installAmikad).not.toHaveBeenCalled();
  });

  it("deletes it when the daemon stops during lume create, on a deadline of its own", async () => {
    const stopping = new AbortController();
    const { deps, run, vms } = failingCreate({ createExit: 143 });
    run.mockImplementationOnce(async (_command, _args, _env, signal) => {
      vms.push(MACOS_BASE_VM);
      stopping.abort();
      expect(signal).toBe(stopping.signal);
      return 143;
    });
    await expect(
      buildMacosImage(
        "amika-macos-coder",
        {},
        { ...deps, signal: stopping.signal },
      ),
    ).rejects.toThrow(/Deleted the half-made base VM/);
    const [, args, , signal] = run.mock.calls[1];
    expect(args).toEqual(["delete", MACOS_BASE_VM, "--force"]);
    // Not the stop's signal, which has already fired.
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    expect(vms).toEqual([]);
  });

  it("deletes nothing when lume create left no base VM", async () => {
    const { deps, run } = failingCreate({ leaves: false });
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow(`No base VM ${MACOS_BASE_VM} was left behind.`);
    expect(run).toHaveBeenCalledOnce();
  });

  it("names the command that deletes it when lume delete fails", async () => {
    const { deps } = failingCreate({ deleteExit: 1 });
    await expect(
      buildMacosImage("amika-macos-coder", {}, deps),
    ).rejects.toThrow(
      `Could not delete the half-made base VM ${MACOS_BASE_VM} (\`lume delete\` exit 1); delete it with \`lume delete ${MACOS_BASE_VM} --force\` before the next try.`,
    );
  });
});

describe("buildMacosImage, stopped", () => {
  it("passes the stop to Lume's checks and amikad's download", async () => {
    const stopping = new AbortController();
    const { deps } = mac({ vms: [MACOS_BASE_VM] });
    await buildMacosImage(
      "amika-macos-coder",
      {},
      { ...deps, signal: stopping.signal },
    );
    expect(deps.hasLumeVm.mock.calls[0]).toEqual([
      LUME,
      MACOS_BASE_VM,
      stopping.signal,
    ]);
    expect(deps.installAmikad.mock.calls[0]).toEqual([
      {},
      expect.objectContaining({ signal: stopping.signal }),
    ]);
  });

  it("starts nothing more once stopped while checking for the base VM", async () => {
    const stopping = new AbortController();
    const { deps, run } = mac();
    const build = buildMacosImage(
      "amika-macos-coder",
      {},
      {
        ...deps,
        signal: stopping.signal,
        hasLumeVm: vi.fn(async () => {
          stopping.abort();
          return false;
        }),
      },
    );
    await expect(build).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(deps.installAmikad).not.toHaveBeenCalled();
  });
});

describe("runToStderr", () => {
  it("on abort, stops the processes the command started too", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-run-"));
    const pidFile = path.join(dir, "child.pid");
    // As build.sh waiting on `lume clone`: bash's own TERM handling waits
    // for the child, which must get the signal itself.
    const script = `sleep 30 & echo $! > "${pidFile}"; wait`;
    const stopping = new AbortController();
    const running = runToStderr(
      "/bin/bash",
      ["-c", script],
      process.env,
      stopping.signal,
    );
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const child = Number(readFileSync(pidFile, "utf8"));
    stopping.abort();
    await running;
    await vi.waitFor(() => expect(isRunning(child)).toBe(false));
  });

  it("on abort, settles only once the command has run its own cleanup and exited", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-run-"));
    const marker = path.join(dir, "cleaned");
    // As build.sh does: clean up on the way out, here slowly.
    const script = `trap 'sleep 0.3; : > "${marker}"; exit 143' TERM; sleep 30 & wait`;
    const stopping = new AbortController();
    const running = runToStderr(
      "/bin/bash",
      ["-c", script],
      process.env,
      stopping.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopping.abort();
    const code = await running;
    expect(existsSync(marker)).toBe(true);
    expect(code).toBe(143);
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("progressFilter", () => {
  const download = (percent: number) =>
    `[2026-11-12T22:29:28Z] INFO: Downloading IPSW Progress: ${percent}%`;
  const install = (percent: number) =>
    `[2026-11-12T23:02:31Z] INFO: Installing macOS progress=${percent}%`;

  it("shows every other line, and progress every 5%", () => {
    const shown: string[] = [];
    const show = progressFilter((line) => shown.push(line), { now: () => 0 });
    show("INFO: Creating VM");
    for (let percent = 0; percent <= 12; percent++) show(download(percent));
    show("INFO: Download completed");
    expect(shown).toEqual([
      "INFO: Creating VM",
      download(0),
      download(5),
      download(10),
      "INFO: Download completed",
    ]);
  });

  it("shows progress every 2 minutes when it is slower than 5% in that time", () => {
    const shown: string[] = [];
    let now = 0;
    const show = progressFilter((line) => shown.push(line), {
      now: () => now,
    });
    show(download(1));
    now = 119_000;
    show(download(2));
    now = 120_000;
    show(download(3));
    expect(shown).toEqual([download(1), download(3)]);
  });

  it("follows the download and the install apart, and shows each 100% once", () => {
    const shown: string[] = [];
    const show = progressFilter((line) => shown.push(line), { now: () => 0 });
    show(download(98));
    show(download(100));
    show(download(100));
    show(install(0));
    show(install(2));
    expect(shown).toEqual([download(98), download(100), install(0)]);
  });
});

describe.runIf(process.platform === "darwin")("runShowingProgress", () => {
  it("passes on each line as the command prints it, in a terminal", async () => {
    // Lume buffers its output unless it is a terminal.
    const shown: { line: string; at: number }[] = [];
    const started = Date.now();
    const code = await runShowingProgress(
      "/bin/bash",
      [
        "-c",
        '[ -t 1 ] && echo tty; echo "Downloading IPSW Progress: 1%"; sleep 1; echo done',
      ],
      process.env,
      undefined,
      (line) => shown.push({ line, at: Date.now() - started }),
    );
    expect(code).toBe(0);
    expect(shown.map(({ line }) => line)).toEqual([
      "tty",
      "Downloading IPSW Progress: 1%",
      "done",
    ]);
    expect(shown[1].at).toBeLessThan(shown[2].at - 500);
  });

  it("on abort, stops the command", async () => {
    const stopping = new AbortController();
    const running = runShowingProgress(
      "/bin/bash",
      ["-c", "echo started; sleep 30"],
      process.env,
      stopping.signal,
      () => stopping.abort(),
    );
    const started = Date.now();
    await running;
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
