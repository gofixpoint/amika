import { describe, expect, it, vi } from "vitest";
import { hostPlatformFor } from "../platforms/index.js";
import { ConfigError } from "./config.js";
import { planInstalls, runInstalls } from "./runtime-install.js";
import type { EngineFiles } from "./smol-setup.js";

const LINUX = hostPlatformFor("linux", {
  arch: () => "x64",
  glibcVersion: () => "2.39",
  kvm: () => "ok",
  hasResize2fs: () => true,
  path: "",
  isExecutable: (file) => file === "/usr/sbin/sshd",
});

const ENGINE: EngineFiles = {
  dir: "/data",
  checksums: `${"a".repeat(64)}  smolmachines-linux-x64-gnu-1.22.2.tgz\n`,
};

/** A machine with nothing installed yet, every installer faked. */
function deps() {
  return {
    env: { AMIKA_HOSTD_HOME: "/nonexistent/hostd" },
    out: () => {},
    platform: LINUX,
    findSmolvm: () => undefined,
    installSmolvm: vi.fn(async () => {}),
    engineFiles: () => ENGINE,
    installEngine: vi.fn(async () => {}),
    findLume: () => undefined,
    installLume: vi.fn(async () => {}),
    installAmikad: vi.fn(async () => "/nonexistent/hostd/amikad"),
    strictModesViolation: () => undefined,
  };
}

describe("planInstalls", () => {
  it("lists what each runtime still needs, and installs it in order", async () => {
    const d = deps();
    const plan = planInstalls(["smol", "bare_metal"], {}, d);
    expect(plan.steps.map((step) => step.runtime)).toEqual([
      "smol",
      "smol",
      "bare_metal",
    ]);
    expect(plan.steps.map((step) => step.text)).toEqual([
      expect.stringMatching(/^Install smolvm /),
      expect.stringMatching(/^Download the smolmachines engine/),
      expect.stringMatching(/^Install amikad /),
    ]);
    await runInstalls(plan);
    expect(d.installSmolvm).toHaveBeenCalledOnce();
    expect(d.installEngine).toHaveBeenCalledWith(
      "smolmachines-linux-x64-gnu",
      ENGINE,
      expect.anything(),
    );
    expect(d.installAmikad).toHaveBeenCalledOnce();
  });

  it("lists nothing for what is already there", () => {
    const plan = planInstalls(
      ["smol", "lume"],
      {},
      {
        ...deps(),
        findSmolvm: () => "/opt/smolvm",
        engineFiles: () => undefined,
        findLume: () => "/opt/lume",
      },
    );
    expect(plan.steps).toEqual([]);
  });

  it("refuses smol where its engine does not run, before installing anything", () => {
    const d = {
      ...deps(),
      platform: hostPlatformFor("linux", { glibcVersion: () => undefined }),
    };
    expect(() => planInstalls(["smol"], {}, d)).toThrow(ConfigError);
    expect(d.installSmolvm).not.toHaveBeenCalled();
  });

  it("refuses bare_metal without sshd, before installing anything", () => {
    const d = {
      ...deps(),
      platform: hostPlatformFor("linux", {
        path: "",
        isExecutable: () => false,
      }),
    };
    expect(() => planInstalls(["bare_metal"], {}, d)).toThrow(/sshd/);
  });

  it("passes on what smolvm still needs as warnings", () => {
    const d = {
      ...deps(),
      platform: hostPlatformFor("linux", {
        arch: () => "x64",
        glibcVersion: () => "2.39",
        kvm: () => "denied",
        hasResize2fs: () => true,
      }),
    };
    expect(planInstalls(["smol"], {}, d).warnings).toEqual([
      expect.stringMatching(/cannot use \/dev\/kvm/),
    ]);
  });
});
