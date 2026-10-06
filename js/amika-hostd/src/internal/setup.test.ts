/** Cover `amika-hostd setup` with every prompt and file faked. */
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

function harness({
  answers = [],
  file,
  env = {},
}: {
  answers?: (string | undefined)[];
  file?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const written: Record<string, string> = {};
  const deps = {
    env: { XDG_CONFIG_HOME: "/config", ...env },
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    prompt: vi.fn(async (_question: string) => answers.shift()),
    loadConfigFile: vi.fn((): HostdConfigFile | undefined =>
      file === undefined ? undefined : { path: PATH, contents: file },
    ),
    writeConfigFile: vi.fn((name: string, contents: string) => {
      written[name] = contents;
    }),
    systemHostname: () => "Jakubs-MacBook-Pro.local",
    generateSecretKey: vi.fn(() => NEW_SECRET),
  } satisfies SetupDeps;
  const config = () =>
    resolveConfig({ file: { path: PATH, contents: written[PATH] } });
  return { deps, out, err, written, config };
}

const CONFIGURED = `hostname = "builder"
secret_key = "${OLD_SECRET}"

[sizes.custom]
vcpus = 1
memory_gib = 1
disk_gib = 5
`;

describe("runSetup", () => {
  it("first run: suggests the machine's hostname and generates a secret", async () => {
    const h = harness({ answers: [""] });
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
    expect(h.out).toContain("Rig sizes:");
    expect(h.out).toContain("  tiny    1 vCPU, 2 GiB memory, 10 GiB disk");
    expect(h.out).toContain("  small   2 vCPUs, 4 GiB memory, 16 GiB disk");
    expect(h.out).toContain(`Edit ${PATH} to change these settings.`);
    expect(h.out).toContain(
      "`amika-hostd up` also needs your Amika API key: export AMIKA_HOSTD_API_KEY=<your Amika API key>",
    );
    expect(h.out.slice(-2)).toEqual([
      "Start the daemon with `amika-hostd up`.",
      "To stop the daemon and its VMs, run `amika-hostd down`.",
    ]);
  });

  it("re-asks for an invalid hostname", async () => {
    const h = harness({ answers: ["Not Valid", "builder"] });
    await runSetup(h.deps);
    expect(h.config().hostname).toBe("builder");
    expect(h.err).toHaveLength(1);
  });

  it("a rerun keeps everything by default and leaves sizes alone", async () => {
    const h = harness({ answers: [""], file: CONFIGURED });
    await runSetup(h.deps);
    expect(h.deps.prompt.mock.calls.map(([question]) => question)).toEqual([
      "Hostname [builder]: ",
    ]);
    expect(h.written[PATH]).toBe(CONFIGURED);
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
  });

  it("says a new hostname registers a new host", async () => {
    const h = harness({ answers: ["other"], file: CONFIGURED });
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
      answers: [""],
      file: 'hostname = "builder"\n',
      env: { AMIKA_HOSTD_SECRET_KEY: envSecret },
    });
    await runSetup(h.deps);
    expect(h.config().secretKey).toBe(envSecret);
    expect(h.deps.generateSecretKey).not.toHaveBeenCalled();
    expect(h.out).toContain(
      "Saved the secret key from AMIKA_HOSTD_SECRET_KEY to the file, since Amika may already know it.",
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
    // The environment already has the API key `up` needs.
    expect(h.out.join("\n")).not.toContain("also needs your Amika API key");
  });

  it("changes nothing when input ends early", async () => {
    const h = harness({ answers: [undefined] });
    await expect(runSetup(h.deps)).rejects.toThrow(/nothing was changed/);
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
  });

  it("lets Ctrl-C through to the caller", async () => {
    const h = harness({});
    h.deps.prompt.mockRejectedValueOnce(new PromptCancelled());
    await expect(runSetup(h.deps)).rejects.toBeInstanceOf(PromptCancelled);
    expect(h.deps.writeConfigFile).not.toHaveBeenCalled();
  });

  it("reports a config it cannot write", async () => {
    const h = harness({ answers: [""] });
    h.deps.writeConfigFile.mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await expect(runSetup(h.deps)).rejects.toThrow(
      `Cannot write ${PATH}: EACCES`,
    );
  });

  it("leaves telling the operator to run `up` to `up` itself", async () => {
    const h = harness({ answers: [""] });
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
  it("also replaces a single-quoted placeholder secret", async () => {
    const h = harness({
      answers: ["builder"],
      file: "secret_key = 'REPLACE_ME'\n",
    });
    await runSetup(h.deps);
    expect(h.config().secretKey).toBe(NEW_SECRET);
  });

  it("replaces the placeholder secret without asking", async () => {
    const h = harness({
      answers: ["builder"],
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
