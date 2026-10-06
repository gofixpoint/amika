/** Cover where the API key is stored, with every program and file faked. */
import { describe, expect, it, vi } from "vitest";
import {
  apiKeyFilePath,
  apiKeyStore,
  isValidApiKey,
  KeychainInterrupted,
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

/**
 * A fake `security` that keeps one value. It answers "not found" as the real
 * one does (exit 44), and can refuse to store, refuse to delete, be locked
 * (every command fails, so nothing can be checked), or be killed by Ctrl-C
 * while storing.
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
    (_command: string, args: readonly string[], input?: string): RunResult => {
      if (locked) return { status: 51, stdout: "" };
      if (args[0] === "find-generic-password") {
        return stored === undefined
          ? { status: 44, stdout: "" }
          : { status: 0, stdout: `${stored}\n` };
      }
      if (args[0] === "delete-generic-password") {
        if (!undeletable) stored = undefined;
        return { status: undeletable ? 1 : 0, stdout: "" };
      }
      if (interruptStore) return { status: null, stdout: "", signal: "SIGINT" };
      if (broken) return { status: 1, stdout: "" };
      stored = /-w "([^"]*)"/.exec(input ?? "")?.[1];
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

  it("keeps the key in an owner-only file on Linux", () => {
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

describe("apiKeyStore with a keychain it cannot check", () => {
  it("refuses to fall back while a locked keychain may hold an old key", () => {
    const fs = files();
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: keychain({ locked: true }).run,
    });
    expect(() => store.set("amk_new")).toThrow(/unlock it, or remove/);
    expect(fs.contents[FILE]).toBeUndefined();
  });

  it("still reads the file when the keychain cannot answer", () => {
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...files({ [FILE]: "amk_file\n" }),
      run: keychain({ locked: true }).run,
    });
    expect(store.get()).toBe("amk_file");
  });
});

describe("apiKeyStore when Ctrl-C kills the keychain command", () => {
  it("reports the interrupt instead of falling back to the file", () => {
    const fs = files();
    const store = apiKeyStore(ENV, {
      platform: "darwin",
      ...fs,
      run: keychain({ interruptStore: true }).run,
    });
    expect(() => store.set("amk_new")).toThrow(KeychainInterrupted);
    expect(fs.contents[FILE]).toBeUndefined();
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

describe("apiKeyFilePath", () => {
  it("sits next to the user config file", () => {
    expect(apiKeyFilePath(ENV)).toBe(FILE);
  });
});
