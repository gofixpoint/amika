/** Cover where the API key is stored, with every program and file faked. */
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  apiKeyFilePath,
  apiKeyStore,
  isValidApiKey,
  KeychainInterrupted,
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
/**
 * A fake `security` / `secret-tool` that keeps one value. It answers "not
 * found" as each really does (exit 44; a silent exit 1), and can refuse to
 * store, refuse to delete, be locked (every command fails, so nothing can be
 * checked), or be killed by Ctrl-C while storing.
 */
function keychain({
  broken = false,
  initial,
  undeletable = false,
  locked = false,
  interruptStore = false,
}: {
  broken?: boolean;
  initial?: string;
  undeletable?: boolean;
  locked?: boolean;
  interruptStore?: boolean;
} = {}) {
  let stored = initial;
  const run = vi.fn(
    (command: string, args: readonly string[], input?: string): RunResult => {
      const macOS = command === "security";
      if (locked) {
        return macOS
          ? { status: 51, stdout: "" }
          : { status: 1, stdout: "", stderr: "Cannot unlock the keyring" };
      }
      const reading =
        args[0] === "find-generic-password" || args[0] === "lookup";
      if (reading) {
        if (stored !== undefined) return { status: 0, stdout: `${stored}\n` };
        return macOS ? { status: 44, stdout: "" } : { status: 1, stdout: "" };
      }
      if (args[0] === "delete-generic-password" || args[0] === "clear") {
        if (!undeletable) stored = undefined;
        return { status: undeletable ? 1 : 0, stdout: "" };
      }
      if (interruptStore) return { status: null, stdout: "", signal: "SIGINT" };
      if (broken) return { status: 1, stdout: "" };
      stored = macOS ? /-w "([^"]*)"/.exec(input ?? "")?.[1] : input;
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

describe("apiKeyStore when the keychain refuses a new key", () => {
  it("removes the old keychain key so the file's new one is read", () => {
    const fs = files();
    const fake = keychain({ broken: true, initial: "amk_old" });
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: fake.run,
    });
    store.set("amk_new");
    expect(fake.stored()).toBeUndefined();
    expect(fs.contents[FILE]).toBe("amk_new\n");
    expect(store.get()).toBe("amk_new");
    // A store created later, as `up` does, reads the new key too.
    expect(
      apiKeyStore(ENV, { platform: "darwin", ...fs, run: fake.run }).get(),
    ).toBe("amk_new");
  });

  it("refuses rather than leave the old key shadowing the new one", () => {
    const fs = files();
    const fake = keychain({
      broken: true,
      initial: "amk_old",
      undeletable: true,
    });
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: fake.run,
    });
    expect(() => store.set("amk_new")).toThrow(
      /Cannot store the API key in your macOS login keychain/,
    );
    expect(fs.contents[FILE]).toBeUndefined();
  });
});

describe("apiKeyStore keeping the fallback file in step", () => {
  it("overwrites a fallback key it cannot delete after a keychain write", () => {
    const fs = files({ [FILE]: "amk_old\n" });
    fs.removeFile.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    const fake = keychain();
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: fake.run,
    });
    store.set("amk_new");
    expect(fake.stored()).toBe("amk_new");
    // A session without the keychain reads the file, so it must not be stale.
    expect(fs.contents[FILE]).toBe("amk_new\n");
  });

  it("fails if a fallback key it can neither delete nor overwrite remains", () => {
    const fs = files({ [FILE]: "amk_old\n" });
    fs.removeFile.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    fs.writeFile.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: keychain().run,
    });
    expect(() => store.set("amk_new")).toThrow(`Cannot write ${FILE}: EACCES`);
  });
});

describe("apiKeyStore.remove", () => {
  it("deletes the key from the keychain and the file", () => {
    const fs = files({ [FILE]: "amk_old\n" });
    const fake = keychain({ initial: "amk_old" });
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: fake.run,
    });
    store.remove();
    expect(fake.stored()).toBeUndefined();
    expect(store.get()).toBeUndefined();
  });

  it("fails if the keychain still has the key", () => {
    const fake = keychain({ initial: "amk_old", undeletable: true });
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...files(),
      run: fake.run,
    });
    expect(() => store.remove()).toThrow(/Cannot remove the API key/);
  });

  it("fails without a keychain if the file cannot be deleted", () => {
    const fs = files({ [FILE]: "amk_old\n" });
    fs.removeFile.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    const store = apiKeyStore(ENV, { platform: "linux", ...fs, run: vi.fn() });
    expect(() => store.remove()).toThrow(
      `Cannot remove the API key in ${FILE}`,
    );
  });
});

describe("apiKeyStore with a keychain it cannot check", () => {
  it.each(["darwin", "linux"] as const)(
    "on %s, refuses to fall back while a locked keychain may hold an old key",
    (platform) => {
      const fs = files();
      const store = apiKeyStore(
        { ...ENV, DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" },
        { platform, ...fs, run: keychain({ locked: true }).run },
      );
      expect(() => store.set("amk_new")).toThrow(/unlock it, or remove/);
      expect(fs.contents[FILE]).toBeUndefined();
      expect(() => store.remove()).toThrow(/Cannot remove the API key/);
    },
  );

  it("still reads the file when the keychain cannot answer", () => {
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...files({ [FILE]: "amk_file\n" }),
      run: keychain({ locked: true }).run,
    });
    expect(store.get()).toBe("amk_file");
  });

  it("falls back to the file when secret-tool is not installed", () => {
    const fs = files();
    const missing = Object.assign(new Error("spawn secret-tool ENOENT"), {
      code: "ENOENT",
    });
    const store = apiKeyStore(
      { ...ENV, DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" },
      {
        platform: "linux",
        ...fs,
        run: () => ({ status: null, stdout: "", error: missing }),
      },
    );
    store.set("amk_new");
    expect(fs.contents[FILE]).toBe("amk_new\n");
  });
});

describe("apiKeyStore when Ctrl-C kills the keychain command", () => {
  it.each(["darwin", "linux"] as const)(
    "on %s, reports the interrupt instead of falling back to the file",
    (platform) => {
      const fs = files();
      const store = apiKeyStore(
        { ...ENV, DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" },
        { platform, ...fs, run: keychain({ interruptStore: true }).run },
      );
      expect(() => store.set("amk_new")).toThrow(KeychainInterrupted);
      expect(fs.contents[FILE]).toBeUndefined();
    },
  );
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
