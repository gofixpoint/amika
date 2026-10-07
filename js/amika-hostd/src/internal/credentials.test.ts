/** Cover where hostd's secrets are kept, with every keychain and file faked. */
import { describe, expect, it, vi } from "vitest";
import {
  apiKeyFilePath,
  isValidApiKey,
  openSecrets,
  type Keychain,
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

  it("has no keychain on this platform yet", () => {
    expect(() => openSecrets("keychain", ENV)).toThrow(/^No keychain/);
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
