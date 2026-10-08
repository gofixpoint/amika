/** Cover `amika-hostd setup` with every prompt, file and keychain faked. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveConfig, type HostdConfigFile } from "./config.js";
import { PromptCancelled } from "./prompt.js";
import {
  DEFAULT_PRESET_IMAGES,
  DEFAULT_SIZES,
  renderConfig,
  runSetup,
  suggestHostname,
  type SetupDeps,
} from "./setup.js";

const PATH = "/config/amika-hostd/config.toml";
const OLD_SECRET = "a".repeat(64);
const NEW_SECRET = "b".repeat(64);
const HOST = { id: "host_1", hostname: "builder", url: null };

/**
 * A setup run against fakes. `kind` picks the secret store: with "file" (the
 * default here) the secret key is `secret_key` in the config; with
 * "keychain" both secrets are items in `keychain`.
 */
function harness({
  answers = [],
  secrets = [],
  file,
  storedKey,
  storedSecret,
  kind = "file",
  env = {},
}: {
  answers?: (string | undefined)[];
  secrets?: (string | undefined)[];
  file?: string;
  storedKey?: string;
  /** The secret key already in the keychain. */
  storedSecret?: string;
  kind?: "file" | "keychain";
  env?: NodeJS.ProcessEnv;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const interrupt: { handler?: () => void } = {};
  /** The API key, wherever the store keeps it. */
  const store = {
    description: "the test store",
    value: storedKey,
    get: vi.fn(() => store.value),
    set: vi.fn((value: string) => {
      store.value = value;
    }),
  };
  /** The secret key as a keychain item (keychain store only). */
  const keychainSecret = {
    description: "the test keychain (secret key)",
    value: storedSecret,
    get: vi.fn(() => keychainSecret.value),
    set: vi.fn((value: string) => {
      keychainSecret.value = value;
    }),
  };
  const deps = {
    env: { XDG_CONFIG_HOME: "/config", ...env },
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    prompt: vi.fn(async (_question: string) => answers.shift()),
    promptSecret: vi.fn(async (_question: string) => secrets.shift()),
    secrets: {
      kind,
      apiKey: store,
      secretKey: kind === "keychain" ? keychainSecret : undefined,
    },
    loadConfigFile: vi.fn((): HostdConfigFile | undefined =>
      file === undefined ? undefined : { path: PATH, contents: file },
    ),
    writeConfigFile: vi.fn((name: string, contents: string) => {
      written[name] = contents;
    }),
    systemHostname: () => "Jakubs-MacBook-Pro.local",
    generateSecretKey: vi.fn(() => NEW_SECRET),
    registerHost: vi.fn(
      async (
        _api: { apiUrl: string; apiKey: string },
        _input: { hostname: string; secretKey: string },
        _fetcher?: typeof fetch,
        _cancel?: AbortSignal,
      ): Promise<{ host: typeof HOST; created: boolean }> => ({
        host: HOST,
        created: false,
      }),
    ),
    setHostSecret: vi.fn(async () => HOST),
    // Ctrl-C, sent by `interrupt()` while a listener is set.
    onInterrupt: vi.fn((handler: () => void) => {
      interrupt.handler = handler;
      return () => {
        interrupt.handler = undefined;
      };
    }),
  } satisfies SetupDeps;
  const config = () =>
    resolveConfig({ file: { path: PATH, contents: written[PATH] } });
  return {
    deps,
    out,
    err,
    written,
    store,
    keychainSecret,
    config,
    interrupt: () => interrupt.handler?.(),
    listening: () => interrupt.handler !== undefined,
  };
}

const CONFIGURED = `hostname = "builder"
secret_key = "${OLD_SECRET}"

[sizes.custom]
vcpus = 1
memory_gib = 1
disk_gib = 5
`;

describe("runSetup", () => {
  it("first run: suggests the machine's hostname, generates a secret, stores the key", async () => {
    const h = harness({ answers: [""], secrets: ["amk_123"] });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls[0][0]).toBe(
      "Hostname [jakubs-macbook-pro]: ",
    );
    expect(h.config()).toMatchObject({
      hostname: "jakubs-macbook-pro",
      secretKey: NEW_SECRET,
      sizes: DEFAULT_SIZES,
      images: DEFAULT_PRESET_IMAGES,
    });
    expect(h.store.set).toHaveBeenCalledWith("amk_123");
    expect(h.out).toContain("Stored the API key in the test store.");
    expect(h.out).toContain("Rig sizes:");
    expect(h.out).toContain("  tiny    1 vCPU, 2 GiB memory, 20 GiB disk");
    expect(h.out).toContain("  small   2 vCPUs, 4 GiB memory, 20 GiB disk");
    expect(h.out).toContain(`Edit ${PATH} to change these settings.`);
    expect(h.out.slice(-2)).toEqual([
      "Start the daemon with `amika-hostd up`.",
      "To stop the daemon and its VMs, run `amika-hostd down`.",
    ]);
  });

  it("re-asks for an invalid hostname and an empty or invalid API key", async () => {
    const h = harness({
      answers: ["Not Valid", "builder"],
      secrets: ["", "has space", "amk_123"],
    });
    await runSetup(h.deps);
    expect(h.config().hostname).toBe("builder");
    expect(h.err).toHaveLength(2);
    expect(h.store.value).toBe("amk_123");
  });

  it("a rerun keeps everything by default and leaves sizes alone", async () => {
    // The file store is chosen in the file, as setup leaves it.
    const file = `secret_store = "file"\n${CONFIGURED}`;
    const h = harness({ answers: ["", "", ""], file, storedKey: "k" });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [builder]: ",
      "Regenerate the secret key Amika uses to reach this host? [y/N] ",
      "Update the stored Amika API key? [y/N] ",
    ]);
    expect(h.written[PATH]).toBe(file);
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
    expect(h.deps.promptSecret).not.toHaveBeenCalled();
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it("replaces the stored API key when asked", async () => {
    const h = harness({
      answers: ["", "", "y"],
      secrets: ["amk_new"],
      file: CONFIGURED,
      storedKey: "amk_old",
    });
    await runSetup(h.deps);
    expect(h.store.value).toBe("amk_new");
  });

  it("says a new hostname registers a new host", async () => {
    const h = harness({
      answers: ["other", ""],
      file: CONFIGURED,
      storedKey: "k",
    });
    await runSetup(h.deps);
    expect(h.config()).toMatchObject({
      hostname: "other",
      secretKey: OLD_SECRET,
    });
    expect(h.out.join("\n")).toContain("registers a new host");
  });

  it("saves the environment's secret, not a new one, when the file has none", async () => {
    const envSecret = "c".repeat(64);
    const h = harness({
      answers: ["", ""],
      file: 'hostname = "builder"\n',
      storedKey: "k",
      env: { AMIKA_HOSTD_SECRET_KEY: envSecret },
    });
    await runSetup(h.deps);
    expect(h.config().secretKey).toBe(envSecret);
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
    expect(h.out).toContain(
      `Saved the secret key from AMIKA_HOSTD_SECRET_KEY to ${PATH}, since Amika may already know it.`,
    );
  });

  it("notes settings the environment overrides", async () => {
    const h = harness({
      answers: [""],
      file: CONFIGURED,
      env: {
        AMIKA_HOSTD_HOSTNAME: "prod-box",
        AMIKA_HOSTD_API_KEY: "amk_env",
      },
    });
    await runSetup(h.deps);
    expect(h.out).toContain(
      "Note: AMIKA_HOSTD_HOSTNAME is set in your environment and overrides the hostname in the file.",
    );
  });

  it("does not ask for an API key the environment provides", async () => {
    const h = harness({
      answers: [""],
      env: { AMIKA_HOSTD_API_KEY: "amk_env" },
    });
    await runSetup(h.deps);
    expect(h.deps.promptSecret).not.toHaveBeenCalled();
    expect(h.store.set).not.toHaveBeenCalled();
    expect(h.out).toContain(
      "Using the API key from AMIKA_HOSTD_API_KEY; unset it to use a stored key instead.",
    );
  });

  it("asks for the API key when its variable is set but blank", async () => {
    const h = harness({
      answers: [""],
      secrets: ["amk_123"],
      env: { AMIKA_HOSTD_API_KEY: "   " },
    });
    await runSetup(h.deps);
    expect(h.deps.promptSecret).toHaveBeenCalled();
    expect(h.store.value).toBe("amk_123");
    expect(h.out.join("\n")).not.toContain("Using the API key from");
  });

  it("stores the API key before writing the config", async () => {
    const h = harness({ answers: [""], secrets: ["amk_123"] });
    await runSetup(h.deps);
    expect(h.store.set.mock.invocationCallOrder[0]).toBeLessThan(
      h.deps.writeConfigFile.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["the hostname", { answers: [undefined] }],
    ["the API key", { answers: [""], secrets: [undefined] }],
  ])("changes nothing when input ends at %s", async (_at, input) => {
    const h = harness(input);
    await expect(runSetup(h.deps)).rejects.toThrow(/nothing was changed/);
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it("lets Ctrl-C through to the caller", async () => {
    const h = harness({});
    h.deps.prompt.mockRejectedValueOnce(new PromptCancelled());
    await expect(runSetup(h.deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
  });

  it("reports a config it cannot write", async () => {
    const h = harness({ answers: [""], secrets: ["amk_123"] });
    h.deps.writeConfigFile.mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Cannot write ${PATH}: EACCES`,
    );
  });

  it("leaves telling the operator to run `up` to `up` itself", async () => {
    const h = harness({ answers: [""], secrets: ["amk_123"] });
    await runSetup(h.deps, { fromUp: true });
    expect(h.out.join("\n")).not.toContain("Start the daemon");
  });
});

describe("regenerating the secret key", () => {
  const MARKED = 'hostname = "builder"\nsecret_store = "keychain"\n';
  const FILE_STORE = `hostname = "builder"\nsecret_store = "file"\nsecret_key = "${OLD_SECRET}"\n`;
  /** A host set up before, answering yes to regenerating and no to the rest. */
  const rerun = (
    options: Partial<Parameters<typeof harness>[0]> = {},
  ): ReturnType<typeof harness> =>
    harness({
      kind: "keychain",
      answers: ["", "y", ""],
      file: MARKED,
      storedKey: "amk_stored",
      storedSecret: OLD_SECRET,
      ...options,
    });
  const fileStore = {
    kind: "file" as const,
    file: FILE_STORE,
    storedSecret: undefined,
  };
  const AGAIN =
    "If Amika's requests to this host start failing, run `amika-hostd setup` again and regenerate it, so Amika and this host agree.";

  it("keeps the new key in the keychain, then sends it to Amika", async () => {
    const h = rerun();
    h.deps.registerHost.mockImplementation(async () => {
      expect(h.keychainSecret.value).toBe(NEW_SECRET);
      expect(h.written[PATH]).toBe(MARKED);
      return { host: HOST, created: false };
    });
    await runSetup(h.deps);
    expect(h.deps.registerHost).toHaveBeenCalledWith(
      { apiUrl: "https://app.amika.dev", apiKey: "amk_stored" },
      expect.objectContaining({ hostname: "builder", secretKey: NEW_SECRET }),
      undefined,
      expect.any(AbortSignal),
    );
    expect(h.deps.setHostSecret).toHaveBeenCalledWith(
      expect.anything(),
      HOST,
      NEW_SECRET,
      undefined,
      expect.any(AbortSignal),
    );
    expect(h.out).toContain(
      "Sent the new secret key for host builder to Amika.",
    );
    expect(h.out).toContain(
      "If the daemon is running, restart it to use the new secret key: amika-hostd down, then amika-hostd up.",
    );
  });

  it("keeps the new key in the file with the file store", async () => {
    const h = rerun(fileStore);
    await runSetup(h.deps);
    expect(h.config().secretKey).toBe(NEW_SECRET);
    expect(h.deps.setHostSecret).toHaveBeenCalledWith(
      expect.anything(),
      HOST,
      NEW_SECRET,
      undefined,
      expect.any(AbortSignal),
    );
  });

  it("registers a hostname Amika does not know yet with the new key", async () => {
    const h = rerun({ answers: ["newhost", "y", ""] });
    h.deps.registerHost.mockResolvedValue({ host: HOST, created: true });
    await runSetup(h.deps);
    expect(h.deps.registerHost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hostname: "newhost", secretKey: NEW_SECRET }),
      undefined,
      expect.any(AbortSignal),
    );
    expect(h.deps.setHostSecret).not.toHaveBeenCalled();
    expect(h.out).toContain(
      "Registered host newhost with https://app.amika.dev",
    );
  });

  it.each([
    ["AMIKA_HOSTD_SECRET_KEY", "c".repeat(64)],
    ["AMIKA_HOSTD_HOSTNAME", "from-env"],
    ["AMIKA_HOSTD_API_URL", "https://other.amika.dev"],
    ["AMIKA_API_URL", "https://other.amika.dev"],
    ["AMIKA_HOSTD_API_KEY", "amk_other"],
    ["AMIKA_API_KEY", "amk_other"],
  ])(
    "does not offer to regenerate while %s overrides a setting",
    async (name, value) => {
      const h = rerun({ answers: ["", ""], env: { [name]: value } });
      await runSetup(h.deps);
      expect(
        h.deps.prompt.mock.calls.map(([question]) => question),
      ).not.toContain(
        "Regenerate the secret key Amika uses to reach this host? [y/N] ",
      );
      expect(h.out).toContain(
        `Not offering to regenerate the secret key while ${name} is set; unset it to regenerate it.`,
      );
      expect(h.keychainSecret.value).toBe(OLD_SECRET);
      expect(h.deps.registerHost).not.toHaveBeenCalled();
    },
  );

  it("puts the old key back in the keychain when Amika fails", async () => {
    const h = rerun();
    h.deps.setHostSecret.mockRejectedValue(new Error("Amika is down"));
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Amika is down; the test keychain (secret key) has the old secret key again. ${AGAIN}`,
    );
    expect(h.keychainSecret.value).toBe(OLD_SECRET);
  });

  it("puts the old key back in the file when Amika fails, with the file store", async () => {
    const h = rerun(fileStore);
    h.deps.registerHost.mockRejectedValue(new Error("Amika is down"));
    await expect(runSetup(h.deps)).rejects.toThrow(/^Amika is down; \/config/);
    expect(h.config().secretKey).toBe(OLD_SECRET);
  });

  it("puts the old key back when the keychain fails to confirm the new one, sending nothing", async () => {
    const h = rerun();
    // Written, then the read-back check fails, as `security` can.
    h.keychainSecret.set.mockImplementation((value: string) => {
      h.keychainSecret.value = value;
      if (value === NEW_SECRET) throw new Error("Cannot store the secret key");
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      "Cannot store the secret key; the test keychain (secret key) has the old secret key again, and nothing was sent to Amika.",
    );
    expect(h.keychainSecret.value).toBe(OLD_SECRET);
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
    expect(h.deps.registerHost).not.toHaveBeenCalled();
  });

  it("puts the old key back when the config cannot be written, sending nothing", async () => {
    const h = rerun();
    h.deps.writeConfigFile.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Cannot write ${PATH}: EACCES; the test keychain (secret key) has the old secret key again, and nothing was sent to Amika.`,
    );
    expect(h.keychainSecret.value).toBe(OLD_SECRET);
    expect(h.deps.registerHost).not.toHaveBeenCalled();
  });

  it("puts the old key back on Ctrl-C while Amika is answering, cancelling the request", async () => {
    const h = rerun();
    h.deps.registerHost.mockImplementation(
      (_api, _input, _fetcher, cancel) =>
        new Promise((_, reject) => {
          cancel?.addEventListener("abort", () =>
            reject(new Error("This operation was aborted")),
          );
          h.interrupt();
        }),
    );
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Cancelled while sending the new secret key to Amika; the test keychain (secret key) has the old secret key again. ${AGAIN}`,
    );
    expect(h.keychainSecret.value).toBe(OLD_SECRET);
    expect(h.listening()).toBe(false);
  });

  it("listens for Ctrl-C only while sending", async () => {
    const h = rerun();
    h.deps.registerHost.mockImplementation(async () => {
      expect(h.listening()).toBe(true);
      return { host: HOST, created: false };
    });
    await runSetup(h.deps);
    expect(h.deps.onInterrupt).toHaveBeenCalledOnce();
    expect(h.listening()).toBe(false);
  });

  it("says the new key stayed when the old one cannot be put back", async () => {
    const h = rerun();
    h.deps.setHostSecret.mockRejectedValue(new Error("Amika is down"));
    h.keychainSecret.set.mockImplementation((value: string) => {
      if (value === OLD_SECRET) throw new Error("locked");
      h.keychainSecret.value = value;
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      "Amika is down; the new secret key is still in the test keychain (secret key), since the old one could not be put back: run `amika-hostd setup` again and regenerate it, so Amika and this host agree.",
    );
    expect(h.keychainSecret.value).toBe(NEW_SECRET);
  });

  describe("with a new API key", () => {
    const withNewKey = (secrets: string[]) =>
      rerun({ answers: ["", "y", "y"], secrets });

    it("sends with it, and saves it only once Amika has taken the new secret key", async () => {
      const h = withNewKey(["amk_new"]);
      h.deps.registerHost.mockImplementation(async (api) => {
        expect(api.apiKey).toBe("amk_new");
        expect(h.store.value).toBe("amk_stored");
        return { host: HOST, created: false };
      });
      await runSetup(h.deps);
      expect(h.store.value).toBe("amk_new");
    });

    it("does not save one Amika refused, so a rerun starts from the old one", async () => {
      const h = withNewKey(["amk_typo"]);
      h.deps.registerHost.mockRejectedValue(
        new Error("Amika rejected the API key"),
      );
      await expect(runSetup(h.deps)).rejects.toThrow(
        `Amika rejected the API key; the test keychain (secret key) has the old secret key again. ${AGAIN} The API key you entered was not saved either.`,
      );
      expect(h.store.set).not.toHaveBeenCalled();
      expect(h.keychainSecret.value).toBe(OLD_SECRET);
    });

    it("still says to restart the daemon when it cannot be saved after Amika took the new secret key", async () => {
      const h = withNewKey(["amk_new"]);
      h.store.set.mockImplementation(() => {
        throw new Error("Cannot store the API key: locked");
      });
      await expect(runSetup(h.deps)).rejects.toThrow(
        "Amika and this host now have the new secret key, but the API key you entered could not be saved: Cannot store the API key: locked. If the daemon is running, restart it to use the new secret key: amika-hostd down, then amika-hostd up. Run `amika-hostd setup` again to store the API key.",
      );
      expect(h.keychainSecret.value).toBe(NEW_SECRET);
    });
  });
});

describe("runSetup with the keychain store", () => {
  it("names the keychain when the environment overrides its secret key", async () => {
    const h = harness({
      kind: "keychain",
      answers: [""],
      secrets: ["amk_123"],
      env: { AMIKA_HOSTD_SECRET_KEY: "c".repeat(64) },
    });
    await runSetup(h.deps);
    expect(h.out).toContain(
      "Note: AMIKA_HOSTD_SECRET_KEY is set in your environment and overrides the secret key in the test keychain (secret key).",
    );
  });

  it("does not ask on the installer's seeded config, which already has a hostname", async () => {
    const h = harness({
      kind: "keychain",
      answers: [""],
      secrets: ["amk_123"],
      file: EXAMPLE.replace('# hostname = "my-host"', 'hostname = "builder"'),
    });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [builder]: ",
    ]);
    expect(h.keychainSecret.value).toBe(NEW_SECRET);
    // Setup marks the file, so a later run knows the keychain has the key.
    expect(h.config()).toMatchObject({
      secretStore: "keychain",
      secretStoreInFile: true,
    });
  });

  it("asks before replacing a secret key it cannot find, for a host set up before", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["", "y", ""],
      file: 'hostname = "builder"\nsecret_store = "keychain"\n',
      storedKey: "k",
    });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [builder]: ",
      "Generate a new secret key? [y/N] ",
      "Update the stored Amika API key? [y/N] ",
    ]);
    expect(h.out).toContain(
      "No secret key found in the test keychain (secret key). If it is there but locked, unlock it and run setup again, rather than replace the secret key Amika may know.",
    );
    expect(h.keychainSecret.value).toBe(NEW_SECRET);
  });

  it.each([[""], ["n"], [undefined]])(
    "changes nothing when the operator does not confirm (%j)",
    async (answer) => {
      const h = harness({
        kind: "keychain",
        answers: ["", answer],
        file: 'hostname = "builder"\nsecret_store = "keychain"\n',
        storedKey: "k",
      });
      await expect(runSetup(h.deps)).rejects.toThrow(
        "Stopped without changing anything; unlock the test keychain (secret key) and run `amika-hostd setup` again",
      );
      expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
      expect(h.keychainSecret.set).not.toHaveBeenCalled();
      expect(h.store.set).not.toHaveBeenCalled();
      expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("warns that Amika may hold an older secret for a host it already knows", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["", "y", ""],
      file: 'hostname = "builder"\nsecret_store = "keychain"\n',
      storedKey: "k",
    });
    await runSetup(h.deps);
    expect(h.out).toContain(
      "If builder is already registered with Amika, Amika keeps the secret key it registered with and will be rejected until this host has that one; set it with AMIKA_HOSTD_SECRET_KEY and run setup again.",
    );
  });

  it("does not warn on a true first run", async () => {
    const h = harness({
      kind: "keychain",
      answers: [""],
      secrets: ["amk_123"],
    });
    await runSetup(h.deps);
    expect(h.out.join("\n")).not.toContain("already registered");
    expect(h.out.join("\n")).not.toContain("No secret key found");
  });

  it("keeps the secret key in the keychain, never in the file", async () => {
    const h = harness({
      kind: "keychain",
      answers: [""],
      secrets: ["amk_123"],
    });
    await runSetup(h.deps);
    expect(h.keychainSecret.value).toBe(NEW_SECRET);
    expect(h.written[PATH]).not.toMatch(/secret_key/);
    expect(h.config()).toMatchObject({
      hostname: "jakubs-macbook-pro",
      secretKey: undefined,
      sizes: DEFAULT_SIZES,
    });
    expect(h.out).toContain(
      "Stored the secret key in the test keychain (secret key).",
    );
    expect(h.out).toContain("  secret    (in the test keychain (secret key))");
  });

  it("rewrites the file's secret_store when the environment chose the keychain, and says so", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["", ""],
      file: `secret_store = "file"\n${CONFIGURED}`,
      storedKey: "k",
      env: { AMIKA_HOSTD_SECRET_STORE: "keychain" },
    });
    await runSetup(h.deps);
    expect(h.keychainSecret.value).toBe(OLD_SECRET);
    expect(h.written[PATH]).toBe(
      `secret_store = "keychain"\n${CONFIGURED.replace(`secret_key = "${OLD_SECRET}"\n`, "")}`,
    );
    expect(h.out).toContain(
      `Changed secret_store in ${PATH} from "file" to "keychain", where setup kept the secrets.`,
    );
    expect(h.out).toContain(
      "Note: AMIKA_HOSTD_SECRET_STORE is set in your environment and overrides the secret store in the file.",
    );
  });

  it.each([
    ["no config", undefined],
    [
      "the installer's seeded config",
      EXAMPLE.replace('# hostname = "my-host"', 'hostname = "builder"'),
    ],
  ])(
    'writes secret_store = "file" when the environment chose files for %s',
    async (_, file) => {
      const h = harness({
        answers: [""],
        secrets: ["amk_123"],
        file,
        env: { AMIKA_HOSTD_SECRET_STORE: "file" },
      });
      await runSetup(h.deps);
      // Without the variable, the file alone still chooses files.
      expect(h.config()).toMatchObject({
        secretStore: "file",
        secretKey: NEW_SECRET,
      });
      expect(h.out.join("\n")).not.toContain("Changed secret_store");
    },
  );

  it('keeps a file\'s own secret_store = "file" as its only one', async () => {
    const h = harness({
      answers: [""],
      secrets: ["amk_123"],
      file: 'secret_store = "file"\n',
    });
    await runSetup(h.deps);
    expect(h.written[PATH].match(/secret_store/g)).toHaveLength(1);
  });

  it("rewrites the file's secret_store when the environment chose files", async () => {
    const h = harness({
      answers: ["", ""],
      file: 'hostname = "builder"\nsecret_store = "keychain"\n',
      storedKey: "k",
      env: { AMIKA_HOSTD_SECRET_STORE: "file" },
    });
    await runSetup(h.deps);
    expect(h.config()).toMatchObject({
      secretStore: "file",
      secretKey: NEW_SECRET,
    });
    expect(h.out).toContain(
      `Changed secret_store in ${PATH} from "keychain" to "file", where setup kept the secrets.`,
    );
  });

  it("moves a secret_key from the file into the keychain", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["", ""],
      file: CONFIGURED,
      storedKey: "k",
    });
    await runSetup(h.deps);
    expect(h.keychainSecret.value).toBe(OLD_SECRET);
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
    expect(h.written[PATH]).toBe(
      CONFIGURED.replace(
        `secret_key = "${OLD_SECRET}"\n`,
        'secret_store = "keychain"\n',
      ),
    );
    expect(h.out).toContain(
      `Moving the secret key from ${PATH} into the test keychain (secret key).`,
    );
  });

  it("keeps the keychain's secret over one left in the file", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["", ""],
      file: CONFIGURED,
      storedKey: "k",
      storedSecret: NEW_SECRET,
    });
    await runSetup(h.deps);
    expect(h.keychainSecret.set).not.toHaveBeenCalled();
    expect(h.keychainSecret.value).toBe(NEW_SECRET);
    expect(h.written[PATH]).not.toMatch(/secret_key/);
  });

  it("gives a recreated config the defaults, though the keychain kept the secret", async () => {
    // config.toml was deleted; the keychain still has the host's secret key.
    const h = harness({
      kind: "keychain",
      answers: ["builder", ""],
      storedKey: "k",
      storedSecret: OLD_SECRET,
    });
    await runSetup(h.deps);
    expect(h.config()).toMatchObject({
      hostname: "builder",
      sizes: DEFAULT_SIZES,
      images: DEFAULT_PRESET_IMAGES,
    });
    expect(h.keychainSecret.set).not.toHaveBeenCalled();
  });

  it("leaves a secret already in the keychain alone on a rerun", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["", ""],
      file: 'hostname = "builder"\nsecret_store = "keychain"\n',
      storedKey: "k",
      storedSecret: OLD_SECRET,
    });
    await runSetup(h.deps);
    expect(h.keychainSecret.set).not.toHaveBeenCalled();
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
    expect(h.written[PATH]).toBe(
      'hostname = "builder"\nsecret_store = "keychain"\n',
    );
  });

  it("drops the example's placeholder secret and keeps a new one in the keychain", async () => {
    const h = harness({
      kind: "keychain",
      answers: ["builder"],
      secrets: ["amk_123"],
      file: 'secret_key = "REPLACE_ME"\nport = 3020\n',
    });
    await runSetup(h.deps);
    // A first run, so the default sizes follow.
    expect(h.written[PATH]).toMatch(/^port = 3020\n\nhostname = "builder"\n/);
    expect(h.written[PATH]).not.toMatch(/secret_key/);
    expect(h.keychainSecret.value).toBe(NEW_SECRET);
  });

  it("saves the environment's secret to the keychain when it has none", async () => {
    const envSecret = "c".repeat(64);
    const h = harness({
      kind: "keychain",
      answers: [""],
      secrets: ["amk_123"],
      env: { AMIKA_HOSTD_SECRET_KEY: envSecret },
    });
    await runSetup(h.deps);
    expect(h.keychainSecret.value).toBe(envSecret);
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
  });

  it("leaves the config untouched when the keychain refuses a secret", async () => {
    const h = harness({
      kind: "keychain",
      answers: [""],
      secrets: ["amk_123"],
    });
    h.keychainSecret.set.mockImplementationOnce(() => {
      throw new Error("Cannot store the secret key in the test keychain");
    });
    await expect(runSetup(h.deps)).rejects.toThrow(/Cannot store/);
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
  });
});

const EXAMPLE = readFileSync(
  path.join(import.meta.dirname, "../../config.example.toml"),
  "utf8",
);

describe("renderConfig", () => {
  const values = { hostname: "builder", secretKey: NEW_SECRET };

  it("fills in the shipped example in place, keeping everything else", () => {
    const contents = renderConfig(EXAMPLE, {
      hostname: "builder",
      secretKey: undefined,
      addDefaults: false,
    });
    expect(contents).toBe(
      EXAMPLE.replace('# hostname = "my-host"', 'hostname = "builder"'),
    );
  });

  it("adds a secret_key above the first table with the file store", () => {
    const contents = renderConfig(EXAMPLE, { ...values, addDefaults: false });
    const config = resolveConfig({ file: { path: PATH, contents } });
    expect(config).toMatchObject({
      hostname: "builder",
      secretKey: NEW_SECRET,
    });
    expect(contents.indexOf("secret_key")).toBeLessThan(
      contents.indexOf("[sizes."),
    );
  });

  it("removes a secret_key when the file keeps none", () => {
    const contents = renderConfig(
      `hostname = "old"\nsecret_key = "${OLD_SECRET}"\n# secret_key = "kept"\n`,
      { hostname: "builder", secretKey: undefined, addDefaults: false },
    );
    expect(contents).toBe('hostname = "builder"\n# secret_key = "kept"\n');
  });

  it("replaces existing top-level settings in place", () => {
    const contents = renderConfig(
      `# mine\nhostname = "old"\nport = 4000\n\n[preset_images]\na = "x/y:z"\n`,
      { ...values, addDefaults: false },
    );
    expect(contents).toBe(
      `# mine\nhostname = "builder"\nsecret_key = "${NEW_SECRET}"\nport = 4000\n\n[preset_images]\na = "x/y:z"\n`,
    );
  });

  it("replaces a quoted key in place rather than adding a second one", () => {
    const contents = renderConfig(`"hostname" = "old"\n'secret_key' = 'x'\n`, {
      ...values,
      addDefaults: false,
    });
    expect(contents).toBe(
      `hostname = "builder"\nsecret_key = "${NEW_SECRET}"\n`,
    );
  });

  it("writes a new file with the default sizes and preset images", () => {
    const contents = renderConfig(undefined, { ...values, addDefaults: true });
    expect(resolveConfig({ file: { path: PATH, contents } })).toMatchObject({
      hostname: "builder",
      secretKey: NEW_SECRET,
      images: DEFAULT_PRESET_IMAGES,
      sizes: DEFAULT_SIZES,
    });
  });

  it("uses the same defaults the installer seeds from the example", () => {
    expect(
      resolveConfig({ file: { path: PATH, contents: EXAMPLE } }),
    ).toMatchObject({ sizes: DEFAULT_SIZES, images: DEFAULT_PRESET_IMAGES });
  });
});

describe("runSetup on the shipped example", () => {
  it("also replaces a single-quoted placeholder secret", async () => {
    const h = harness({
      answers: ["builder"],
      secrets: ["amk_123"],
      file: "secret_key = 'REPLACE_ME'\n",
    });
    await runSetup(h.deps);
    expect(h.config().secretKey).toBe(NEW_SECRET);
  });

  it("fills in the shipped example without asking about the secret", async () => {
    const h = harness({
      answers: ["builder"],
      secrets: ["amk_123"],
      file: EXAMPLE,
    });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [jakubs-macbook-pro]: ",
    ]);
    expect(h.config()).toMatchObject({
      hostname: "builder",
      secretKey: NEW_SECRET,
      sizes: DEFAULT_SIZES,
    });
    expect(h.out).toContain("Generated a new secret key.");
  });
});

describe("suggestHostname", () => {
  it.each([
    ["Jakubs-MacBook-Pro.local", "jakubs-macbook-pro"],
    ["build_box", "build-box"],
    ["ip-10-0-0-1.ec2.internal", "ip-10-0-0-1.ec2.internal"],
    ["-weird-", "weird"],
    ["___", undefined],
  ])("turns %j into %j", (raw, expected) => {
    expect(suggestHostname(raw)).toBe(expected);
  });
});
