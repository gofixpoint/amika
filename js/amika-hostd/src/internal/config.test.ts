/** Cover precedence, aliases, and the TOML boundary of daemon settings. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_API_URL,
  configFilePaths,
  envName,
  loadConfigFile,
  requireSettings,
  resolveConfig,
} from "./config.js";

const TOML_SECRET = "0123456789abcdef0123456789abcdef";

function file(contents: string) {
  return { path: "/etc/amika-hostd/config.toml", contents };
}

describe("resolveConfig", () => {
  it("applies defaults when nothing is set", () => {
    expect(resolveConfig({})).toEqual({
      apiKey: undefined,
      apiUrl: DEFAULT_API_URL,
      hostname: undefined,
      secretKey: undefined,
      secretKeyFrom: undefined,
      secretKeyInFile: false,
      secretStore: "keychain",
      secretStoreInFile: false,
      host: "127.0.0.1",
      port: 3020,
      smolApiUrl: undefined,
      smolRequestTimeoutMs: 300_000,
      sizes: {},
      images: {},
      configPath: undefined,
    });
  });

  it("reads every setting from TOML except the API key", () => {
    const config = resolveConfig({
      file: file(`
hostname = " builder "
secret_key = "${TOML_SECRET}"
api_url = "http://localhost:3000/"
host = "0.0.0.0"
port = 4000
`),
    });
    expect(config).toMatchObject({
      hostname: "builder",
      secretKey: TOML_SECRET,
      apiUrl: "http://localhost:3000",
      host: "0.0.0.0",
      port: 4000,
      configPath: "/etc/amika-hostd/config.toml",
    });
  });

  it("prefers flags over environment over TOML", () => {
    const toml = file(`port = 4000\nhost = "toml"\nhostname = "toml"`);
    const env = {
      AMIKA_HOSTD_PORT: "5000",
      AMIKA_HOSTD_HOST: "env",
      AMIKA_HOSTD_HOSTNAME: "env",
    };
    expect(resolveConfig({ env, file: toml })).toMatchObject({
      port: 5000,
      host: "env",
      hostname: "env",
    });
    expect(
      resolveConfig({ flags: { port: "6000", host: "flag" }, env, file: toml }),
    ).toMatchObject({ port: 6000, host: "flag", hostname: "env" });
  });

  it.each([
    ["apiKey", "AMIKA_HOSTD_API_KEY", "AMIKA_API_KEY"],
    ["apiUrl", "AMIKA_HOSTD_API_URL", "AMIKA_API_URL"],
    ["secretKey", "AMIKA_HOSTD_SECRET_KEY", "AMIKA_SECRET_KEY"],
  ] as const)("accepts either name for %s", (key, specific, general) => {
    const value = "http://value.example/0123456789abcdef";
    expect(resolveConfig({ env: { [specific]: value } })[key]).toBe(value);
    expect(resolveConfig({ env: { [general]: value } })[key]).toBe(value);
    expect(
      resolveConfig({ env: { [specific]: value, [general]: value } })[key],
    ).toBe(value);
  });

  it.each([
    ["AMIKA_HOSTD_API_KEY", "AMIKA_API_KEY"],
    ["AMIKA_HOSTD_API_URL", "AMIKA_API_URL"],
    ["AMIKA_HOSTD_SECRET_KEY", "AMIKA_SECRET_KEY"],
  ])("rejects %s and %s set to different values", (specific, general) => {
    const env = { [specific]: "http://a.example", [general]: "http://b" };
    expect(() => resolveConfig({ env })).toThrow(
      new ConfigError(
        `Ambiguous configuration: ${specific} and ${general} are set to different values; unset one of them`,
      ),
    );
  });

  it("treats empty environment values as unset", () => {
    const config = resolveConfig({
      env: { AMIKA_HOSTD_SECRET_KEY: "", AMIKA_SECRET_KEY: TOML_SECRET },
    });
    expect(config.secretKey).toBe(TOML_SECRET);
  });

  it("rejects an API key in the TOML file without echoing it", () => {
    const run = () => resolveConfig({ file: file(`api_key = "do-not-print"`) });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(
      /must not contain api_key; run `amika-hostd setup` to store it, or set AMIKA_HOSTD_API_KEY/,
    );
    expect(run).not.toThrow(/do-not-print/);
  });

  it("rejects unknown keys and invalid TOML without echoing contents", () => {
    expect(() => resolveConfig({ file: file(`hostnme = "typo"`) })).toThrow(
      /invalid settings: hostnme/,
    );
    const invalid = () =>
      resolveConfig({ file: file(`secret_key = "do-not-print`) });
    expect(invalid).toThrow(/is not valid TOML$/);
    expect(invalid).not.toThrow(/do-not-print/);
  });

  it("reads sizes from [sizes] tables, in the shape Amika's API takes", () => {
    const config = resolveConfig({
      file: file(`
[sizes.gpu-large]
vcpus = 8
memory_gib = 32
disk_gib = 100

[sizes."small.1"]
vcpus = 1
memory_gib = 0.5
disk_gib = 10
disk_grow_only = true
`),
    });
    expect(config.sizes).toEqual({
      "gpu-large": {
        vcpus: 8,
        memoryGib: 32,
        diskGib: 100,
        diskGrowOnly: false,
      },
      "small.1": { vcpus: 1, memoryGib: 0.5, diskGib: 10, diskGrowOnly: true },
    });
  });

  it.each([
    ["an unknown key", "gpus = 1", /invalid settings: sizes\.large\.gpus$/],
    ["over 16 vCPUs", "vcpus = 17", /invalid settings: sizes\.large\.vcpus$/],
    [
      "under 64 MiB of memory",
      "memory_gib = 0.05",
      /invalid settings: sizes\.large\.memory_gib$/,
    ],
    [
      "fractional vCPUs",
      "vcpus = 1.5",
      /invalid settings: sizes\.large\.vcpus$/,
    ],
    [
      "memory that isn't whole MiB",
      "memory_gib = 1.0001",
      /invalid settings: sizes\.large\.memory_gib$/,
    ],
    ["zero disk", "disk_gib = 0", /invalid settings: sizes\.large\.disk_gib$/],
  ])("rejects a size with %s", (_label, line, message) => {
    const [key] = line.split(" = ");
    const base = ["vcpus = 4", "memory_gib = 8", "disk_gib = 40"].filter(
      (entry) => !entry.startsWith(`${key} `),
    );
    const table = ["[sizes.large]", ...base, line].join("\n");
    expect(() => resolveConfig({ file: file(table) })).toThrow(message);
  });

  it("reads image references from the [preset_images] table", () => {
    const config = resolveConfig({
      file: file(`
[preset_images]
amika-coder = "ghcr.io/gofixpoint/amika-coder:0123456789ab"
amika-coder-plus-docker = " ghcr.io/gofixpoint/amika-coder-plus-docker:0123456789ab "
`),
    });
    expect(config.images).toEqual({
      "amika-coder": "ghcr.io/gofixpoint/amika-coder:0123456789ab",
      "amika-coder-plus-docker":
        "ghcr.io/gofixpoint/amika-coder-plus-docker:0123456789ab",
    });
  });

  it.each([
    ["an empty reference", `amika-coder = ""`, /preset_images\.amika-coder$/],
    ["a blank reference", `amika-coder = "  "`, /preset_images\.amika-coder$/],
    [
      "a non-string reference",
      `amika-coder = 1`,
      /preset_images\.amika-coder$/,
    ],
    ["an empty name", `"" = "ghcr.io/x:y"`, /invalid settings: preset_images/],
  ])("rejects a [preset_images] table with %s", (_label, line, message) => {
    expect(() =>
      resolveConfig({ file: file(`[preset_images]\n${line}`) }),
    ).toThrow(message);
  });

  it("rejects preset_images that aren't a table", () => {
    expect(() =>
      resolveConfig({ file: file(`preset_images = "ghcr.io/x:y"`) }),
    ).toThrow(/invalid settings: preset_images$/);
  });

  it("rejects the 0.1.0 [images] table", () => {
    expect(() =>
      resolveConfig({ file: file(`[images]\namika-coder = "ghcr.io/x:y"`) }),
    ).toThrow(/invalid settings: images$/);
  });

  it.each(["", "  "])("rejects an empty --host %j", (host) => {
    // An empty bind address would listen on every interface.
    expect(() => resolveConfig({ flags: { host } })).toThrow(
      new ConfigError("--host must not be empty"),
    );
  });

  it.each(["0", "65536", "80.5", "http", "0x50", "1e3", " 80", "80 "])(
    "rejects port %j",
    (port) => {
      expect(() => resolveConfig({ flags: { port } })).toThrow(
        `Invalid port: ${port}`,
      );
    },
  );

  it.each(["not a url", "file:///tmp", "https://user:pass@example.com"])(
    "rejects API URL %s",
    (url) => {
      expect(() => resolveConfig({ env: { AMIKA_API_URL: url } })).toThrow(
        ConfigError,
      );
    },
  );

  it.each([
    ["too short", "a".repeat(31)],
    ["padded with spaces", ` ${TOML_SECRET} `],
    ["containing a space", `${TOML_SECRET} x`],
    ["containing a tab", `${TOML_SECRET}\t`],
    ["non-ASCII", `${TOML_SECRET}é`],
  ])("rejects a secret key %s without echoing it", (_, secret) => {
    for (const run of [
      () => resolveConfig({ env: { AMIKA_HOSTD_SECRET_KEY: secret } }),
      () =>
        resolveConfig({
          file: file(`secret_key = ${JSON.stringify(secret)}`),
        }),
    ]) {
      expect(run).toThrow(/^secret key must be at least 32 printable ASCII/);
      expect(run).not.toThrow(TOML_SECRET);
    }
  });

  it("accepts a 32-character printable secret key", () => {
    const secret = "!~" + "a".repeat(30);
    expect(
      resolveConfig({ env: { AMIKA_HOSTD_SECRET_KEY: secret } }).secretKey,
    ).toBe(secret);
  });

  it.each([
    "builder",
    "build-01",
    "ci.eu-west.example",
    "a".repeat(63),
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
  ])("accepts hostname %s", (hostname) => {
    expect(
      resolveConfig({ env: { AMIKA_HOSTD_HOSTNAME: hostname } }).hostname,
    ).toBe(hostname);
  });

  it.each([
    "Builder",
    "my_host",
    "-builder",
    "builder-",
    "builder.",
    ".builder",
    "a..b",
    "build er",
    "a".repeat(64),
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
  ])("rejects hostname %j", (hostname) => {
    expect(() =>
      resolveConfig({ env: { AMIKA_HOSTD_HOSTNAME: hostname } }),
    ).toThrow(/^Invalid hostname: /);
  });

  it("rejects a blank hostname in the file", () => {
    expect(() =>
      resolveConfig({
        file: { path: "/c.toml", contents: 'hostname = "   "' },
      }),
    ).toThrow(/^Invalid hostname: /);
  });

  it("treats a blank environment variable as unset, like an empty one", () => {
    const config = resolveConfig({
      env: { AMIKA_HOSTD_HOSTNAME: "   ", AMIKA_HOSTD_API_KEY: " \t" },
      file: { path: "/c.toml", contents: 'hostname = "builder"' },
    });
    expect(config).toMatchObject({ hostname: "builder", apiKey: undefined });
  });

  it("names the variable that sets a setting, skipping blank ones", () => {
    expect(
      envName({ AMIKA_HOSTD_API_KEY: "  ", AMIKA_API_KEY: "k" }, "apiKey"),
    ).toBe("AMIKA_API_KEY");
    expect(envName({ AMIKA_HOSTD_API_KEY: "  " }, "apiKey")).toBeUndefined();
  });
});

describe("secret store", () => {
  it("is the keychain unless the file or environment chooses files", () => {
    expect(resolveConfig({}).secretStore).toBe("keychain");
    expect(
      resolveConfig({ file: file('secret_store = "file"') }).secretStore,
    ).toBe("file");
    expect(
      resolveConfig({
        env: { AMIKA_HOSTD_SECRET_STORE: "keychain" },
        file: file('secret_store = "file"'),
      }).secretStore,
    ).toBe("keychain");
  });

  it.each([
    ["the file", { file: file('secret_store = "vault"') }],
    ["the environment", { env: { AMIKA_HOSTD_SECRET_STORE: "plain" } }],
  ])("rejects an unknown store in %s", (_where, input) => {
    expect(() => resolveConfig(input)).toThrow(/^Invalid secret store: /);
  });

  it("records where the secret key came from", () => {
    expect(resolveConfig({}).secretKeyFrom).toBeUndefined();
    expect(
      resolveConfig({ file: file(`secret_key = "${TOML_SECRET}"`) })
        .secretKeyFrom,
    ).toBe("file");
    expect(
      resolveConfig({
        env: { AMIKA_HOSTD_SECRET_KEY: TOML_SECRET },
        file: file(`secret_key = "${TOML_SECRET}"`),
      }).secretKeyFrom,
    ).toBe("env");
  });
});

describe("requireSettings", () => {
  it("names every missing setting and where to set it", () => {
    expect(() =>
      requireSettings(resolveConfig({}), ["apiKey", "hostname", "secretKey"]),
    ).toThrow(
      [
        "Missing required configuration:",
        "  - API key: run `amika-hostd setup`, or set AMIKA_HOSTD_API_KEY or AMIKA_API_KEY",
        "  - hostname: run `amika-hostd setup`, or set AMIKA_HOSTD_HOSTNAME or `hostname` in config.toml",
        "  - secret key: run `amika-hostd setup`, or set AMIKA_HOSTD_SECRET_KEY or AMIKA_SECRET_KEY",
      ].join("\n"),
    );
  });

  it("names the config file for the secret key only with the file store", () => {
    expect(() =>
      requireSettings(
        resolveConfig({ env: { AMIKA_HOSTD_SECRET_STORE: "file" } }),
        ["secretKey"],
      ),
    ).toThrow(/or `secret_key` in config\.toml$/);
  });

  it("returns the config once everything is present", () => {
    const config = resolveConfig({
      env: { AMIKA_API_KEY: "key", AMIKA_HOSTD_HOSTNAME: "builder" },
    });
    expect(requireSettings(config, ["apiKey", "hostname"]).hostname).toBe(
      "builder",
    );
  });
});

describe("loadConfigFile", () => {
  it("prefers the user config over /etc and honors XDG_CONFIG_HOME", () => {
    const env = { XDG_CONFIG_HOME: "/xdg" };
    expect(configFilePaths(env)).toEqual([
      "/xdg/amika-hostd/config.toml",
      "/etc/amika-hostd/config.toml",
    ]);
    const files: Record<string, string> = {
      "/xdg/amika-hostd/config.toml": "user",
      "/etc/amika-hostd/config.toml": "system",
    };
    const read = (path: string) => {
      if (path in files) return files[path];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    expect(loadConfigFile(env, read)?.contents).toBe("user");
    delete files["/xdg/amika-hostd/config.toml"];
    expect(loadConfigFile(env, read)).toEqual({
      path: "/etc/amika-hostd/config.toml",
      contents: "system",
    });
    delete files["/etc/amika-hostd/config.toml"];
    expect(loadConfigFile(env, read)).toBeUndefined();
  });

  it("reports unreadable files instead of skipping them", () => {
    const read = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(() => loadConfigFile({ XDG_CONFIG_HOME: "/xdg" }, read)).toThrow(
      "Cannot read /xdg/amika-hostd/config.toml: EACCES",
    );
  });
});

describe("config.example.toml", () => {
  const example = file(
    readFileSync(new URL("../../config.example.toml", import.meta.url), "utf8"),
  );

  /** The example as the installer seeds it: with this machine's hostname. */
  const seeded = file(
    example.contents.replace('# hostname = "my-host"', 'hostname = "my-host"'),
  );

  it("documents the line the installer fills in", () => {
    expect(example.contents).toMatch(/^# hostname = "my-host"$/m);
  });

  it("holds no secret, and documents the default secret store", () => {
    expect(example.contents).not.toMatch(/^\s*secret_key\s*=/m);
    expect(example.contents).toMatch(/^# secret_store = "keychain"$/m);
    expect(resolveConfig({ file: example })).toMatchObject({
      secretKey: undefined,
      secretStore: "keychain",
    });
  });

  it("lets the environment supply the required settings", () => {
    const config = resolveConfig({
      file: example,
      env: {
        AMIKA_API_KEY: "api-key",
        AMIKA_HOSTD_HOSTNAME: "builder",
        AMIKA_HOSTD_SECRET_KEY: TOML_SECRET,
      },
    });
    expect(
      requireSettings(config, ["apiKey", "hostname", "secretKey"]),
    ).toMatchObject({ hostname: "builder", secretKey: TOML_SECRET });
  });

  it("resolves once seeded, with defaults that match the code", () => {
    expect(resolveConfig({ file: seeded })).toMatchObject({
      hostname: "my-host",
      secretStore: "keychain",
      apiUrl: DEFAULT_API_URL,
      host: "127.0.0.1",
      port: 3020,
      sizes: {
        tiny: { vcpus: 1, memoryGib: 2, diskGib: 10, diskGrowOnly: false },
        small: { vcpus: 2, memoryGib: 4, diskGib: 16, diskGrowOnly: false },
        medium: { vcpus: 4, memoryGib: 8, diskGib: 24, diskGrowOnly: false },
        large: { vcpus: 8, memoryGib: 16, diskGib: 40, diskGrowOnly: false },
        xlarge: { vcpus: 16, memoryGib: 24, diskGib: 40, diskGrowOnly: false },
      },
      images: {
        "amika-coder": "ghcr.io/gofixpoint/amika-coder:latest",
        "amika-coder-plus-docker":
          "ghcr.io/gofixpoint/amika-coder-plus-docker:latest",
      },
    });
  });
});
