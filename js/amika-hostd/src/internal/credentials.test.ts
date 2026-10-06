/** Cover where the API key is stored, with every file faked. */
import { describe, expect, it, vi } from "vitest";
import { apiKeyFilePath, apiKeyStore, isValidApiKey } from "./credentials.js";

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

describe("apiKeyStore", () => {
  it("keeps the key in an owner-only file", () => {
    const fs = files();
    const store = apiKeyStore(ENV, fs);
    expect(store.get()).toBeUndefined();
    store.set("amk_123");
    expect(fs.contents[FILE]).toBe("amk_123\n");
    expect(store.get()).toBe("amk_123");
    expect(store.description).toBe(`${FILE} (readable only by you)`);
  });

  it("replaces a key it stored before", () => {
    const fs = files({ [FILE]: "amk_old\n" });
    const store = apiKeyStore(ENV, fs);
    store.set("amk_new");
    expect(store.get()).toBe("amk_new");
  });

  it("reads a blank file as no key", () => {
    expect(apiKeyStore(ENV, files({ [FILE]: " \n" })).get()).toBeUndefined();
  });

  it("names the file, never the key, when it cannot be read or written", () => {
    const fs = files({ [FILE]: "amk_secret\n" });
    const denied = () => {
      throw Object.assign(new Error("denied amk_secret"), { code: "EACCES" });
    };
    fs.readFile.mockImplementation(denied);
    fs.writeFile.mockImplementation(denied);
    const store = apiKeyStore(ENV, fs);
    expect(() => store.get()).toThrow(`Cannot read ${FILE}: EACCES`);
    expect(() => store.set("amk_new")).toThrow(`Cannot write ${FILE}: EACCES`);
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
