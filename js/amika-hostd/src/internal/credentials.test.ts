/** Cover where the API key is stored, with every program and file faked. */
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  apiKeyFilePath,
  apiKeyStore,
  isValidApiKey,
  writePrivateFile,
  type RunResult,
} from "./credentials.js";

const ENV = { XDG_CONFIG_HOME: "/config" };
const FILE = "/config/amika-hostd/api-key";

function files(initial: Record<string, string> = {}) {
  const contents = { ...initial };
  return {
    contents,
    readFile: vi.fn((file: string) => {
      if (!(file in contents)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return contents[file];
    }),
    writeFile: vi.fn((file: string, value: string) => {
      contents[file] = value;
    }),
    removeFile: vi.fn((file: string) => {
      delete contents[file];
    }),
  };
}

/** A fake keychain program that keeps one value, or refuses to store it. */
function keychain({ broken = false } = {}) {
  let stored: string | undefined;
  const run = vi.fn(
    (command: string, args: readonly string[], input?: string): RunResult => {
      const reading =
        args[0] === "find-generic-password" || args[0] === "lookup";
      if (reading) {
        return stored === undefined
          ? { status: 44, stdout: "" }
          : { status: 0, stdout: `${stored}\n` };
      }
      if (broken) return { status: 1, stdout: "" };
      stored =
        command === "security" ? /-w "([^"]*)"/.exec(input ?? "")?.[1] : input;
      return { status: 0, stdout: "" };
    },
  );
  return { run, stored: () => stored };
}

describe("apiKeyStore", () => {
  it("keeps the key in the macOS keychain, off the command line", () => {
    const fs = files({ [FILE]: "old\n" });
    const fake = keychain();
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: fake.run,
    });
    store.set("amk_123");
    expect(fake.stored()).toBe("amk_123");
    expect(store.get()).toBe("amk_123");
    expect(store.description).toBe("your macOS login keychain");
    const [, args, input] = fake.run.mock.calls[0];
    expect(args).toEqual(["-i"]);
    expect(input).toContain('-w "amk_123"');
    // A stale copy in the file is removed.
    expect(fs.contents[FILE]).toBeUndefined();
  });

  it("uses the Secret Service on a Linux desktop session", () => {
    const fake = keychain();
    const store = apiKeyStore(
      { ...ENV, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      { platform: "linux", ...files(), run: fake.run },
    );
    store.set("amk_123");
    expect(fake.run.mock.calls[0][0]).toBe("secret-tool");
    expect(fake.run.mock.calls[0][2]).toBe("amk_123");
    expect(store.get()).toBe("amk_123");
  });

  it("falls back to an owner-only file without a desktop session", () => {
    const fs = files();
    const run = vi.fn();
    const store = apiKeyStore(ENV, { platform: "linux", ...fs, run });
    expect(store.get()).toBeUndefined();
    store.set("amk_123");
    expect(run).not.toHaveBeenCalled();
    expect(fs.contents[FILE]).toBe("amk_123\n");
    expect(store.get()).toBe("amk_123");
    expect(store.description).toBe(`${FILE} (readable only by you)`);
  });

  it("falls back to the file when the keychain will not store the key", () => {
    const fs = files();
    const fake = keychain({ broken: true });
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: fake.run,
    });
    store.set("amk_123");
    expect(fs.contents[FILE]).toBe("amk_123\n");
    expect(store.description).toContain(FILE);
    expect(store.get()).toBe("amk_123");
  });
});

describe("isValidApiKey", () => {
  it.each(["amk_live_abc123", "a.b-c~d"])("accepts %j", (key) => {
    expect(isValidApiKey(key)).toBe(true);
  });

  it.each(["", "has space", 'quo"te', "back\\slash", "it's"])(
    "rejects %j",
    (key) => {
      expect(isValidApiKey(key)).toBe(false);
    },
  );
});

describe("writePrivateFile", () => {
  it("creates the directory and a file only its owner can read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
    const file = path.join(dir, "nested", "api-key");
    writePrivateFile(file, "secret\n");
    expect(readFileSync(file, "utf8")).toBe("secret\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });
});

describe("apiKeyFilePath", () => {
  it("sits next to the user config file", () => {
    expect(apiKeyFilePath(ENV)).toBe(FILE);
  });
});
