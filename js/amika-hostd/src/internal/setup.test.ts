/** Cover `amika-hostd setup` with every prompt, file and request faked. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AmikaApiError } from "./amika-api.js";
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

function harness({
  answers = [],
  secrets = [],
  file,
  storedKey,
  env = {},
}: {
  answers?: (string | undefined)[];
  secrets?: (string | undefined)[];
  file?: string;
  storedKey?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  /** Ctrl-C, while setup listens for it. */
  const interrupt: { handler?: () => void } = {};
  const store = {
    description: "the test store",
    value: storedKey,
    get: vi.fn(() => store.value),
    set: vi.fn((value: string) => {
      store.value = value;
    }),
    remove: vi.fn(() => {
      store.value = undefined;
    }),
  };
  const deps = {
    env: { XDG_CONFIG_HOME: "/config", ...env },
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    prompt: vi.fn(async (_question: string) => answers.shift()),
    promptSecret: vi.fn(async (_question: string) => secrets.shift()),
    credentials: store,
    loadConfigFile: vi.fn((): HostdConfigFile | undefined =>
      file === undefined ? undefined : { path: PATH, contents: file },
    ),
    writeConfigFile: vi.fn((name: string, contents: string) => {
      written[name] = contents;
    }),
    systemHostname: () => "Jakubs-MacBook-Pro.local",
    generateSecretKey: vi.fn(() => NEW_SECRET),
    registerHost: vi.fn(async () => ({ host: HOST, created: false })),
    setHostSecret: vi.fn(
      async (_api: { signal?: AbortSignal }, _host: unknown, _secret: string) =>
        HOST,
    ),
    onInterrupt: vi.fn((handler: () => void) => {
      interrupt.handler = handler;
      return () => {
        interrupt.handler = undefined;
      };
    }),
  } satisfies SetupDeps;
  const config = () =>
    resolveConfig({ file: { path: PATH, contents: written[PATH] } });
  return { deps, out, err, written, store, config, interrupt };
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
    // A new secret on a first run reaches Amika when `up` registers.
    expect(h.deps.registerHost).not.toHaveBeenCalled();
    expect(h.out).toContain("Rig sizes:");
    expect(h.out).toContain("  tiny    1 vCPU, 2 GiB memory, 10 GiB disk");
    expect(h.out).toContain("  small   2 vCPUs, 4 GiB memory, 16 GiB disk");
    expect(h.out).toContain(`Edit ${PATH} to change these settings.`);
    expect(h.out.slice(-2)).toEqual([
      "Start the daemon with `amika-hostd up`.",
      "To stop the daemon and its VMs, run `amika-hostd down`.",
    ]);
  });

  it("re-asks for an invalid hostname and an empty API key", async () => {
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
    const h = harness({
      answers: ["", "", ""],
      file: CONFIGURED,
      storedKey: "amk_old",
    });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [builder]: ",
      "Regenerate the secret key Amika uses to reach this host? [y/N] ",
      "Update the stored Amika API key? [y/N] ",
    ]);
    expect(h.written[PATH]).toBe(CONFIGURED);
    expect(h.deps.promptSecret).not.toHaveBeenCalled();
    expect(h.store.set).not.toHaveBeenCalled();
    expect(h.deps.registerHost).not.toHaveBeenCalled();
  });

  it("regenerating the secret writes it, then sends it to Amika", async () => {
    const h = harness({
      answers: ["", "y", "y"],
      secrets: ["amk_new"],
      file: CONFIGURED,
      storedKey: "amk_old",
    });
    await runSetup(h.deps);
    const api = expect.objectContaining({
      apiUrl: "https://app.amika.dev",
      apiKey: "amk_new",
    });
    expect(h.deps.registerHost).toHaveBeenCalledWith(
      api,
      expect.objectContaining({ hostname: "builder", secretKey: NEW_SECRET }),
    );
    expect(h.deps.setHostSecret).toHaveBeenCalledWith(api, HOST, NEW_SECRET);
    expect(h.deps.writeConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      h.deps.setHostSecret.mock.invocationCallOrder[0],
    );
    expect(h.config().secretKey).toBe(NEW_SECRET);
    expect(h.store.value).toBe("amk_new");
  });

  /** A rerun that regenerates the secret of the registered host `builder`. */
  const rotating = () =>
    harness({ answers: ["", "y", ""], file: CONFIGURED, storedKey: "k" });
  const secretsSent = (h: ReturnType<typeof harness>) =>
    h.deps.setHostSecret.mock.calls.map(([, , secret]) => secret);

  it("restores the file and key, not Amika, when Amika refuses the new secret", async () => {
    const h = harness({
      answers: ["", "y", "y"],
      secrets: ["amk_new"],
      file: CONFIGURED,
      storedKey: "amk_old",
    });
    h.deps.setHostSecret.mockRejectedValueOnce(
      new AmikaApiError("failed to update the host's secret key (HTTP 404)", {
        refused: true,
      }),
    );
    await expect(runSetup(h.deps)).rejects.toThrow(
      "failed to update the host's secret key (HTTP 404); setup changed nothing",
    );
    expect(h.written[PATH]).toBe(CONFIGURED);
    expect(h.store.value).toBe("amk_old");
    // Amika answered no, so it still has the old secret; nothing to undo.
    expect(secretsSent(h)).toEqual([NEW_SECRET]);
  });

  it.each([
    ["a timeout", new AmikaApiError("cannot reach Amika: timed out")],
    ["a 502", new AmikaApiError("failed (HTTP 502)", { refused: false })],
    ["an unexpected error", new Error("boom")],
  ])(
    "after %s, which may have applied it, puts the old secret back in Amika too",
    async (_name, failure) => {
      const h = rotating();
      h.deps.setHostSecret.mockRejectedValueOnce(failure);
      await expect(runSetup(h.deps)).rejects.toThrow(/setup changed nothing$/);
      expect(h.written[PATH]).toBe(CONFIGURED);
      expect(secretsSent(h)).toEqual([NEW_SECRET, OLD_SECRET]);
    },
  );

  it("says what may be left changed when undoing fails", async () => {
    const h = rotating();
    h.deps.setHostSecret
      .mockRejectedValueOnce(new AmikaApiError("cannot reach Amika: timed out"))
      .mockRejectedValueOnce(
        new AmikaApiError("cannot reach Amika: timed out"),
      );
    await expect(runSetup(h.deps)).rejects.toThrow(
      /undoing setup's changes failed: Amika may not have the secret key in .*: run `amika-hostd setup` again and regenerate it/,
    );
    expect(h.written[PATH]).toBe(CONFIGURED);
  });

  it("rolls back everything on Ctrl-C while Amika is being updated", async () => {
    const h = harness({
      answers: ["", "y", "y"],
      secrets: ["amk_new"],
      file: CONFIGURED,
      storedKey: "amk_old",
    });
    // The request hangs until Ctrl-C cancels it.
    h.deps.setHostSecret.mockImplementationOnce(
      (api) =>
        new Promise((_, reject) => {
          api.signal?.addEventListener("abort", () =>
            reject(new AmikaApiError("cannot reach Amika: aborted")),
          );
          h.interrupt.handler?.();
        }),
    );
    await expect(runSetup(h.deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(h.written[PATH]).toBe(CONFIGURED);
    expect(h.store.value).toBe("amk_old");
    expect(secretsSent(h)).toEqual([NEW_SECRET, OLD_SECRET]);
    expect(h.err).toContain(
      "Interrupted; undoing setup's changes. Press Ctrl-C again to stop now.",
    );
    // A second Ctrl-C is not caught, so it stops setup at once.
    expect(h.interrupt.handler).toBeUndefined();
  });

  it("rolls back on Ctrl-C while the API key is being stored", async () => {
    const h = harness({
      answers: ["", "y", "y"],
      secrets: ["amk_new"],
      file: CONFIGURED,
      storedKey: "amk_old",
    });
    // A keychain command blocks (e.g. on an unlock prompt) and Ctrl-C lands.
    h.store.set.mockImplementationOnce((value: string) => {
      h.store.value = value;
      h.interrupt.handler?.();
    });
    await expect(runSetup(h.deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(h.store.value).toBe("amk_old");
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
    expect(h.deps.registerHost).not.toHaveBeenCalled();
  });

  it("undoes even a change Amika already confirmed when Ctrl-C follows it", async () => {
    const h = rotating();
    h.deps.setHostSecret.mockImplementationOnce(async () => {
      h.interrupt.handler?.();
      return HOST;
    });
    await expect(runSetup(h.deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(h.written[PATH]).toBe(CONFIGURED);
    expect(secretsSent(h)).toEqual([NEW_SECRET, OLD_SECRET]);
  });

  it("removes a key it stored when there was none before", async () => {
    const h = harness({
      answers: [""],
      secrets: ["amk_new"],
      file: CONFIGURED,
    });
    h.deps.writeConfigFile.mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Cannot write ${PATH}: EACCES; setup changed nothing`,
    );
    expect(h.store.remove).toHaveBeenCalled();
    expect(h.store.value).toBeUndefined();
  });

  it("deletes a config file it created when undoing", async () => {
    // A first run: no config file, and no stored key.
    const h = harness({ answers: [""], secrets: ["amk_new"] });
    const removeConfigFile = vi.fn();
    h.deps.writeConfigFile.mockImplementationOnce(
      (file: string, contents: string) => {
        h.written[file] = contents;
        h.interrupt.handler?.();
      },
    );
    await expect(
      runSetup({ ...h.deps, removeConfigFile }),
    ).rejects.toBeInstanceOf(PromptCancelled);
    expect(removeConfigFile).toHaveBeenCalledWith(PATH);
    expect(h.store.value).toBeUndefined();
  });

  it("listens for Ctrl-C only while setup applies its changes", async () => {
    const h = rotating();
    await runSetup(h.deps);
    expect(h.deps.onInterrupt).toHaveBeenCalledTimes(1);
    expect(h.interrupt.handler).toBeUndefined();
  });

  it("never sends a new secret it could not write", async () => {
    const h = harness({
      answers: ["", "y", ""],
      file: CONFIGURED,
      storedKey: "k",
    });
    h.deps.writeConfigFile.mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Cannot write ${PATH}: EACCES`,
    );
    expect(h.deps.registerHost).not.toHaveBeenCalled();
    expect(h.deps.setHostSecret).not.toHaveBeenCalled();
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
    expect(h.deps.setHostSecret).not.toHaveBeenCalled();
    expect(h.out).toContain(
      "Saved the secret key from AMIKA_HOSTD_SECRET_KEY to the file, since Amika may already know it.",
    );
  });

  it("does not offer to regenerate a secret the environment overrides", async () => {
    const h = harness({
      answers: ["", ""],
      file: CONFIGURED,
      storedKey: "k",
      env: { AMIKA_HOSTD_SECRET_KEY: "c".repeat(64) },
    });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [builder]: ",
      "Update the stored Amika API key? [y/N] ",
    ]);
    expect(h.config().secretKey).toBe(OLD_SECRET);
    expect(h.deps.setHostSecret).not.toHaveBeenCalled();
  });

  it("sends a new secret for the hostname the environment sets", async () => {
    const h = harness({
      answers: ["", "y", ""],
      file: CONFIGURED,
      storedKey: "k",
      env: { AMIKA_HOSTD_HOSTNAME: "prod-box" },
    });
    await runSetup(h.deps);
    expect(h.deps.registerHost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hostname: "prod-box", secretKey: NEW_SECRET }),
    );
  });

  it("a new hostname with a new secret registers afresh on `up` instead", async () => {
    const h = harness({
      answers: ["other", "y", ""],
      file: CONFIGURED,
      storedKey: "k",
    });
    await runSetup(h.deps);
    expect(h.deps.registerHost).not.toHaveBeenCalled();
    expect(h.config()).toMatchObject({
      hostname: "other",
      secretKey: NEW_SECRET,
    });
    expect(h.out.join("\n")).toContain("registers a new host");
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

  it("changes nothing when input ends early", async () => {
    const h = harness({ answers: [""], secrets: [undefined] });
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

  it("leaves telling the operator to run `up` to `up` itself", async () => {
    const h = harness({ answers: [""], secrets: ["amk_123"] });
    await runSetup(h.deps, { fromUp: true });
    expect(h.out.join("\n")).not.toContain("Start the daemon");
  });
});

const EXAMPLE = readFileSync(
  path.join(import.meta.dirname, "../../config.example.toml"),
  "utf8",
);

describe("renderConfig", () => {
  const values = { hostname: "builder", secretKey: NEW_SECRET };

  it("fills in the shipped example in place, keeping everything else", () => {
    const contents = renderConfig(EXAMPLE, { ...values, addDefaults: false });
    expect(contents).toBe(
      EXAMPLE.replace('# hostname = "my-host"', 'hostname = "builder"').replace(
        'secret_key = "REPLACE_ME"',
        `secret_key = "${NEW_SECRET}"`,
      ),
    );
  });

  it("replaces existing top-level settings in place", () => {
    const contents = renderConfig(
      `# mine\nhostname = "old"\nport = 4000\n\n[preset_images]\na = "x/y:z"\n`,
      { ...values, addDefaults: false },
    );
    expect(contents).toBe(
      `# mine\nhostname = "builder"\nport = 4000\nsecret_key = "${NEW_SECRET}"\n\n[preset_images]\na = "x/y:z"\n`,
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
    const seeded = EXAMPLE.replace(
      'secret_key = "REPLACE_ME"',
      `secret_key = "${NEW_SECRET}"`,
    );
    expect(
      resolveConfig({ file: { path: PATH, contents: seeded } }),
    ).toMatchObject({ sizes: DEFAULT_SIZES, images: DEFAULT_PRESET_IMAGES });
  });
});

describe("runSetup on the shipped example", () => {
  it("replaces the placeholder secret without asking", async () => {
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
