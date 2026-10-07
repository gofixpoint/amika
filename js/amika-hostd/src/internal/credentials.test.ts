/** Cover where hostd's secrets are kept, with every keychain and file faked. */
import { describe, expect, it, vi } from "vitest";
import {
  apiKeyFilePath,
  isValidApiKey,
  KeychainInterrupted,
  openSecrets,
  type Keychain,
  type RunResult,
  type SecretName,
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
  };
}

/** A keychain that keeps its items in memory. */
function memoryKeychain(): Keychain & { items: Map<SecretName, string> } {
  const items = new Map<SecretName, string>();
  return {
    items,
    description: "the test keychain",
    get: (name) => items.get(name),
    set: (name, value) => void items.set(name, value),
  };
}

describe("openSecrets with the file store", () => {
  it("keeps the API key in an owner-only file, and no secret key", () => {
    const fs = files();
    const secrets = openSecrets("file", ENV, { ...fs, keychain: null });
    expect(secrets.secretKey).toBeUndefined();
    expect(secrets.apiKey.get()).toBeUndefined();
    secrets.apiKey.set("amk_123");
    expect(fs.contents[FILE]).toBe("amk_123\n");
    expect(secrets.apiKey.get()).toBe("amk_123");
    expect(secrets.apiKey.description).toBe(`${FILE} (readable only by you)`);
  });

  it("never touches the keychain, even when there is one", () => {
    const keychain = memoryKeychain();
    keychain.items.set("api-key", "amk_in_keychain");
    const secrets = openSecrets("file", ENV, { ...files(), keychain });
    expect(secrets.apiKey.get()).toBeUndefined();
  });

  it("reads a blank file as no key", () => {
    const secrets = openSecrets("file", ENV, files({ [FILE]: " \n" }));
    expect(secrets.apiKey.get()).toBeUndefined();
  });

  it("names the file, never the key, when it cannot be read or written", () => {
    const fs = files({ [FILE]: "amk_secret\n" });
    const denied = () => {
      throw Object.assign(new Error("denied amk_secret"), { code: "EACCES" });
    };
    fs.readFile.mockImplementation(denied);
    fs.writeFile.mockImplementation(denied);
    const { apiKey } = openSecrets("file", ENV, fs);
    expect(() => apiKey.get()).toThrow(`Cannot read ${FILE}: EACCES`);
    expect(() => apiKey.set("amk_new")).toThrow(`Cannot write ${FILE}: EACCES`);
  });
});

describe("openSecrets with the keychain store", () => {
  it("keeps both secrets as keychain items, and never a file", () => {
    const fs = files();
    const keychain = memoryKeychain();
    const secrets = openSecrets("keychain", ENV, { ...fs, keychain });
    secrets.apiKey.set("amk_123");
    secrets.secretKey?.set("s".repeat(64));
    expect(keychain.items.get("api-key")).toBe("amk_123");
    expect(keychain.items.get("secret-key")).toBe("s".repeat(64));
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(secrets.apiKey.description).toBe(
      "the test keychain (Amika API key)",
    );
  });

  it("never reads the file, so a key left there cannot shadow the keychain", () => {
    const keychain = memoryKeychain();
    const secrets = openSecrets("keychain", ENV, {
      ...files({ [FILE]: "amk_old\n" }),
      keychain,
    });
    expect(secrets.apiKey.get()).toBeUndefined();
  });

  it("refuses without a keychain, naming the setting that chooses files", () => {
    expect(() => openSecrets("keychain", ENV, { keychain: null })).toThrow(
      'No keychain on this machine to keep amika-hostd\'s secrets in. To keep them in files only you can read instead, set `secret_store = "file"` in /config/amika-hostd/config.toml, or AMIKA_HOSTD_SECRET_STORE=file',
    );
  });

  it("has no keychain on Linux", () => {
    expect(() =>
      openSecrets("keychain", ENV, { platform: "linux", run: vi.fn() }),
    ).toThrow(/^No keychain/);
  });
});

/**
 * A fake `security` keeping generic passwords by account. It answers "not
 * found" as the real one does (exit 44), and can be locked (every command
 * fails), refuse to store, or be killed by Ctrl-C.
 */
function security({
  locked = false,
  refuseStore = false,
  interrupt = false,
}: { locked?: boolean; refuseStore?: boolean; interrupt?: boolean } = {}) {
  const items = new Map<string, string>();
  const run = vi.fn(
    (_command: string, args: readonly string[], input?: string): RunResult => {
      if (interrupt) return { status: null, stdout: "", signal: "SIGINT" };
      if (locked) return { status: 51, stdout: "" };
      if (args[0] === "find-generic-password") {
        const value = items.get(args[args.indexOf("-a") + 1]);
        return value === undefined
          ? { status: 44, stdout: "" }
          : { status: 0, stdout: `${value}\n` };
      }
      // `security -i`: the command arrives on stdin.
      const command = /-a (\S+) .* -w "([^"]*)"/.exec(input ?? "");
      if (!refuseStore && command) items.set(command[1], command[2]);
      return { status: 0, stdout: "" };
    },
  );
  return { run, items };
}

describe("the macOS keychain", () => {
  const open = (fake: ReturnType<typeof security>) =>
    openSecrets("keychain", ENV, { platform: "darwin", run: fake.run });

  it("keeps both secrets as login-keychain items, off the command line", () => {
    const fake = security();
    const secrets = open(fake);
    secrets.apiKey.set("amk_123");
    secrets.secretKey?.set("s".repeat(64));
    expect(fake.items).toEqual(
      new Map([
        ["api-key", "amk_123"],
        ["secret-key", "s".repeat(64)],
      ]),
    );
    expect(secrets.apiKey.get()).toBe("amk_123");
    expect(secrets.apiKey.description).toBe(
      "your macOS login keychain (Amika API key)",
    );
    for (const [, args] of fake.run.mock.calls) {
      expect(args.join(" ")).not.toContain("amk_123");
    }
  });

  it("reads a missing item as unset", () => {
    expect(open(security()).apiKey.get()).toBeUndefined();
  });

  it("refuses a keychain it cannot read, saying how to fix it", () => {
    expect(() => open(security({ locked: true })).apiKey.get()).toThrow(
      'Cannot read the Amika API key for amika-hostd from your macOS login keychain; unlock it and run `amika-hostd setup` again, or set `secret_store = "file"` to keep secrets in files',
    );
  });

  it("fails if the item did not stick", () => {
    expect(() =>
      open(security({ refuseStore: true })).apiKey.set("amk_123"),
    ).toThrow(/^Cannot store the Amika API key for amika-hostd in/);
  });

  it.each(['has"quote', "back\\slash", "has space"])(
    "refuses to quote %j into a security command",
    (value) => {
      const fake = security();
      expect(() => open(fake).secretKey?.set(value)).toThrow(
        /spaces, quotes or backslashes/,
      );
      expect(fake.run).not.toHaveBeenCalled();
    },
  );

  it("reports a command killed by Ctrl-C", () => {
    expect(() => open(security({ interrupt: true })).apiKey.get()).toThrow(
      KeychainInterrupted,
    );
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
  it("is in the user config directory", () => {
    expect(apiKeyFilePath(ENV)).toBe(FILE);
  });
});
