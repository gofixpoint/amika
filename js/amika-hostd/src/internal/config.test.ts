/** Cover precedence, aliases, and the TOML boundary of daemon settings. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_API_URL,
  configFilePaths,
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
      host: "127.0.0.1",
      port: 3020,
      smolApiUrl: undefined,
      smolRequestTimeoutMs: 300_000,
      sizes: {},
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
    expect(run).toThrow(/must not contain api_key; set AMIKA_API_KEY/);
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
    ["over 255 vCPUs", "vcpus = 256", /invalid settings: sizes\.large\.vcpus$/],
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
    "   ",
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
});

describe("requireSettings", () => {
  it("names every missing setting and where to set it", () => {
    expect(() =>
      requireSettings(resolveConfig({}), ["apiKey", "hostname", "secretKey"]),
    ).toThrow(
      [
        "Missing required configuration:",
        "  - API key: set AMIKA_HOSTD_API_KEY or AMIKA_API_KEY (environment only)",
        "  - hostname: set AMIKA_HOSTD_HOSTNAME or `hostname` in config.toml",
        "  - secret key: set AMIKA_HOSTD_SECRET_KEY or AMIKA_SECRET_KEY or `secret_key` in config.toml",
      ].join("\n"),
    );
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

  /** Uncomment one documented `key = …` line, failing if it is missing. */
  function uncomment(contents: string, key: string): string {
    const line = new RegExp(`^# ${key} = `, "m");
    expect(contents, `config.example.toml documents ${key}`).toMatch(line);
    return contents.replace(line, `${key} = `);
  }

  it("resolves as shipped, leaving the required settings to the operator", () => {
    const config = resolveConfig({ file: example });
    expect(config).toMatchObject({ hostname: undefined, secretKey: undefined });
    expect(() =>
      requireSettings(config, ["apiKey", "hostname", "secretKey"]),
    ).toThrow(/hostname: set AMIKA_HOSTD_HOSTNAME[\s\S]*secret key: set/);
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

  it("documents a size table that resolves as written", () => {
    const sizes = example.contents.slice(
      example.contents.indexOf("# [sizes.medium]"),
    );
    const contents = sizes.replace(/^# ?/gm, "");
    expect(resolveConfig({ file: file(contents) })).toMatchObject({
      sizes: {
        medium: { vcpus: 4, memoryGib: 8, diskGib: 40, diskGrowOnly: false },
      },
    });
  });

  it("documents every setting, with defaults that match the code", () => {
    let contents = example.contents;
    for (const key of ["hostname", "secret_key", "api_url", "host", "port"]) {
      contents = uncomment(contents, key);
    }
    contents = contents.replace(
      'secret_key = "<output of openssl rand -hex 32>"',
      `secret_key = "${TOML_SECRET}"`,
    );
    expect(resolveConfig({ file: file(contents) })).toMatchObject({
      hostname: "my-host",
      secretKey: TOML_SECRET,
      apiUrl: DEFAULT_API_URL,
      host: "127.0.0.1",
      port: 3020,
    });
  });
});
