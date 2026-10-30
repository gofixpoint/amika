/** Cover the platform registry and what each platform reads from the OS. */
import { describe, expect, it, vi } from "vitest";
import {
  PlatformUnsupportedError,
  currentHostPlatform,
  hostPlatformFor,
  toHostPlatform,
} from "./index.js";
import type { PlatformDeps } from "./shared.js";

const GIB = 1024 ** 3;

/** An OS answering with fixed values. */
const fakeOs = (overrides: PlatformDeps = {}): PlatformDeps => ({
  availableParallelism: () => 12,
  totalmem: () => 32 * GIB,
  statfs: () => ({ bsize: 4096, blocks: (500 * GIB) / 4096 }),
  homedir: () => "/home/op",
  arch: () => "x64",
  path: "",
  isExecutable: () => false,
  ...overrides,
});

describe("hostPlatformFor", () => {
  it.each(["linux", "darwin"] as const)(
    "offers bare metal, VMs and a keychain on %s",
    (name) => {
      const platform = hostPlatformFor(name);
      expect(platform.name).toBe(name);
      expect(platform.capabilities).toEqual({
        bareMetal: true,
        vmRuntime: true,
        keychain: true,
      });
    },
  );

  it.each(["win32", "freebsd", "aix"] as const)(
    "resolves %s to an unsupported platform that offers nothing",
    (name) => {
      const platform = hostPlatformFor(name);
      expect(platform.name).toBe(name);
      expect(platform.capabilities).toEqual({
        bareMetal: false,
        vmRuntime: false,
        keychain: false,
      });
      expect(() => platform.detectResources()).toThrow(
        PlatformUnsupportedError,
      );
      expect(() => platform.amikadAsset()).toThrow(PlatformUnsupportedError);
      expect(platform.findSshd()).toBeUndefined();
      expect(
        platform.keychain({ DBUS_SESSION_BUS_ADDRESS: "unix:x" }, vi.fn()),
      ).toBeUndefined();
    },
  );

  it("resolves this machine's platform once", () => {
    expect(currentHostPlatform()).toBe(currentHostPlatform());
    expect(toHostPlatform(undefined)).toBe(currentHostPlatform());
  });

  it("takes a platform by name or as itself", () => {
    const darwin = hostPlatformFor("darwin");
    expect(toHostPlatform(darwin)).toBe(darwin);
    expect(toHostPlatform("linux").name).toBe("linux");
  });
});

describe("detectResources", () => {
  it("reports logical CPUs, memory and the home filesystem's size", () => {
    const statfs = vi.fn(() => ({ bsize: 4096, blocks: (500 * GIB) / 4096 }));
    const resources = hostPlatformFor(
      "linux",
      fakeOs({ statfs }),
    ).detectResources();
    expect(resources).toEqual({
      vcpus: 12,
      memoryGib: 32,
      diskGib: 500,
      os: "linux",
      arch: "x64",
    });
    expect(statfs).toHaveBeenCalledWith("/home/op");
  });

  it("rounds to a tenth of a GiB", () => {
    const resources = hostPlatformFor(
      "darwin",
      fakeOs({
        totalmem: () => 17_179_869_184 + 123_456_789,
        statfs: () => ({ bsize: 512, blocks: 1_000_000_000 }),
        arch: () => "arm64",
      }),
    ).detectResources();
    expect(resources).toMatchObject({
      memoryGib: 16.1,
      diskGib: 476.8,
      os: "darwin",
      arch: "arm64",
    });
  });
});

describe("findSshd", () => {
  it("prefers sshd on PATH, then where packages put it", () => {
    const executable = new Set(["/opt/ssh/sbin/sshd", "/usr/sbin/sshd"]);
    const isExecutable = (file: string) => executable.has(file);
    expect(
      hostPlatformFor(
        "linux",
        fakeOs({ path: "relative:/opt/ssh/sbin:/usr/bin", isExecutable }),
      ).findSshd(),
    ).toBe("/opt/ssh/sbin/sshd");
    expect(
      hostPlatformFor(
        "linux",
        fakeOs({ path: "/usr/bin", isExecutable }),
      ).findSshd(),
    ).toBe("/usr/sbin/sshd");
  });

  it("finds none, and says how to install one", () => {
    const linux = hostPlatformFor("linux", fakeOs());
    expect(linux.findSshd()).toBeUndefined();
    expect(linux.sshdInstallHint).toMatch(/openssh-server/);
  });
});

describe("amikadAsset", () => {
  it.each([
    ["linux", "x64", { os: "linux", arch: "amd64" }],
    ["linux", "arm64", { os: "linux", arch: "arm64" }],
    ["darwin", "arm64", { os: "darwin", arch: "arm64" }],
    ["darwin", "x64", { os: "darwin", arch: "amd64" }],
  ] as const)("names %s/%s as amikad's release does", (os, arch, asset) => {
    expect(
      hostPlatformFor(os, fakeOs({ arch: () => arch })).amikadAsset(),
    ).toEqual(asset);
  });

  it("refuses an architecture amikad is not released for", () => {
    expect(() =>
      hostPlatformFor("linux", fakeOs({ arch: () => "ppc64" })).amikadAsset(),
    ).toThrow("amika-hostd does not support amikad on linux/ppc64");
  });
});

describe("keychain", () => {
  it("is the Secret Service on Linux only with a session bus", () => {
    const linux = hostPlatformFor("linux");
    expect(linux.keychain({}, vi.fn())).toBeUndefined();
    expect(linux.keychain({ DBUS_SESSION_BUS_ADDRESS: " " }, vi.fn())).toBe(
      undefined,
    );
    expect(
      linux.keychain({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, vi.fn())
        ?.description,
    ).toMatch(/Secret Service/);
  });

  it("is the login keychain on macOS", () => {
    expect(hostPlatformFor("darwin").keychain({}, vi.fn())?.description).toBe(
      "your macOS login keychain",
    );
  });
});

describe("processCommand", () => {
  it("names this process's program", () => {
    const program = currentHostPlatform().processCommand(process.pid, "comm");
    expect(program).toBeTruthy();
  });

  it("knows nothing of a pid that is not running", () => {
    expect(
      currentHostPlatform().processCommand(2 ** 22 + 1, "command"),
    ).toBeUndefined();
  });
});
