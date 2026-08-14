import { describe, expect, it } from "vitest";
import { defineProvider, type ProviderDefinition } from "./define-provider";
import {
  SandboxProviderUnsupportedError,
  type SandboxProviderCapabilities,
} from "../provider";

const ALL_OFF: SandboxProviderCapabilities = {
  lifecycle: false,
  ssh: false,
  services: false,
  exec: false,
  listSandboxes: false,
  streaming: false,
  snapshots: false,
  scrubCapture: false,
  fullSnapshotCapture: false,
  dockerRegistries: false,
  skipStartScript: false,
  snapshotIdsAreOpaque: false,
  supportsAutoDelete: false,
};

/** The always-required `sandbox` namespace, with fake create/delete. */
const SANDBOX_NAMESPACE: ProviderDefinition["sandbox"] = {
  create: async () => ({
    provider: "daytona",
    providerSandboxId: "sb_1",
    providerUrl: null,
    services: [],
  }),
  delete: async () => {},
};

/**
 * Definition overrides for the test helpers. `sandbox` is a *partial* here (so a
 * test can supply just the run-state ops without repeating create/delete) and is
 * merged onto {@link SANDBOX_NAMESPACE}; every other namespace replaces wholesale.
 */
type DefOverrides = Partial<Omit<ProviderDefinition, "sandbox">> & {
  sandbox?: Partial<ProviderDefinition["sandbox"]>;
};

/** A minimal grouped definition: only the always-required `sandbox` namespace. */
function minimalDef(overrides: DefOverrides = {}): ProviderDefinition {
  const { sandbox, ...rest } = overrides;
  return {
    name: "daytona",
    signedUrlTtlSeconds: 0,
    userHomeDir: "/home/amika",
    sandbox: { ...SANDBOX_NAMESPACE, ...sandbox },
    ...rest,
  };
}

/** Build a provider from explicit flags + definition overrides. */
function build(
  capabilities: SandboxProviderCapabilities,
  overrides: DefOverrides = {},
) {
  return defineProvider(capabilities, () => minimalDef(overrides))({});
}

/** A coherent lifecycle bundle: run-state + services + cloneRepo, together. */
const LIFECYCLE_MEMBERS: DefOverrides = {
  cloneRepo: async () => {},
  sandbox: {
    start: async () => {},
    stop: async () => {},
    getState: async () => "running",
  },
  services: {
    refreshUrls: async () => ({ providerUrl: null, services: [] }),
    syncRoutes: async () => {},
  },
};

describe("defineProvider metadata + defaults", () => {
  it("passes through the metadata and required sandbox namespace", async () => {
    const provider = build(ALL_OFF);
    expect(provider.name).toBe("daytona");
    expect(provider.capabilities).toBe(ALL_OFF);
    expect(provider.signedUrlTtlSeconds).toBe(0);
    await expect(
      provider.sandboxes.get("sb_1").delete(),
    ).resolves.toBeUndefined();
  });

  it("gates every omitted namespace behind unsupported/null on the objects", async () => {
    const provider = build(ALL_OFF);
    const sbox = provider.sandboxes.get("sb_1");
    // Object methods over omitted capabilities reject with unsupported...
    await expect(sbox.start()).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    await expect(sbox.exec("ls")).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    await expect(sbox.readFile("/f")).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    await expect(provider.sandboxes.list()).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    // ...and the richer sub-namespaces / top-level namespaces are null.
    expect(sbox.ssh).toBeNull();
    expect(sbox.services).toBeNull();
    expect(sbox.snapshots).toBeNull();
    expect(provider.snapshots).toBeNull();
    expect(provider.docker).toBeNull();
  });

  it("leaves Sandbox.git null when the clone primitive is omitted", () => {
    const provider = build(ALL_OFF);
    // No `cloneRepo` override → no `git` namespace; the provisioning layer
    // clones over the adapter exec port instead.
    expect(provider.sandboxes.get("sb_1").git).toBeNull();
  });

  it("passes the config through the closure to the definition", async () => {
    const factory = defineProvider(ALL_OFF, (config: { token: string }) =>
      minimalDef({
        sandbox: {
          create: async () => ({
            provider: "daytona",
            providerSandboxId: config.token,
            providerUrl: null,
            services: [],
          }),
          delete: async () => {},
        },
      }),
    );
    const created = await factory({ token: "sb_from_config" }).sandboxes.create(
      // ctx/input are unused by this fake
      {} as never,
      {} as never,
    );
    expect(created.id).toBe("sb_from_config");
  });
});

describe("defineProvider capability reconciliation", () => {
  it("throws when a flag is declared with no backing namespace", () => {
    expect(() => build({ ...ALL_OFF, snapshots: true })).toThrow(
      /capability "snapshots"=true but the definition omits it/,
    );
  });

  it("throws when a namespace is provided while its flag is false", () => {
    // A snapshot object present under `snapshots: false` — the API would gate on
    // the non-null object while the UI reports the capability as unsupported.
    expect(() => build(ALL_OFF, { snapshots: {} as never })).toThrow(
      /capability "snapshots"=false but the definition provides it/,
    );
    expect(() =>
      build(ALL_OFF, { exec: { run: async () => ({}) as never } }),
    ).toThrow(/capability "exec"=false but the definition provides it/);
  });

  it("throws when streaming is declared but exec has no stream", () => {
    expect(() =>
      build(
        { ...ALL_OFF, exec: true, streaming: true },
        {
          exec: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
        },
      ),
    ).toThrow(/capability "streaming"=true but the definition omits it/);
  });

  it("throws when the lifecycle members aren't enabled together", () => {
    // run-state ops present but the rest of the lifecycle bundle (services,
    // cloneRepo) missing — callers reach all three under the `lifecycle` gate.
    expect(() =>
      build(
        { ...ALL_OFF, lifecycle: true },
        {
          sandbox: {
            start: async () => {},
            stop: async () => {},
            getState: async () => "running",
          },
        },
      ),
    ).toThrow(/lifecycle members must be enabled together/);
  });

  it("throws when the sandbox run-state ops aren't all present", () => {
    // `start` alone — start/stop/getState are a unit, so a partial set is a
    // definition bug the flattened `sandbox` type no longer catches.
    expect(() =>
      build(
        { ...ALL_OFF, lifecycle: true },
        { sandbox: { start: async () => {} } },
      ),
    ).toThrow(/run-state ops \(start\/stop\/getState\) must be all present/);
  });

  it("throws when lifecycle members are present but the flag is false", () => {
    expect(() => build(ALL_OFF, LIFECYCLE_MEMBERS)).toThrow(
      /capability "lifecycle"=false but the definition provides it/,
    );
  });

  it("accepts a coherent lifecycle provider", () => {
    expect(() =>
      build({ ...ALL_OFF, lifecycle: true, services: true }, LIFECYCLE_MEMBERS),
    ).not.toThrow();
  });
});

describe("defineProvider object assembly", () => {
  it("create() returns a Sandbox carrying the create result", async () => {
    const created = {
      provider: "daytona",
      providerSandboxId: "sb_1",
      providerUrl: null,
      services: [],
    };
    const provider = build(ALL_OFF, {
      sandbox: { create: async () => created, delete: async () => {} },
    });
    const sbox = await provider.sandboxes.create({} as never, {} as never);
    expect(sbox.id).toBe("sb_1");
    expect(sbox.created).toBe(created);
    await expect(sbox.delete()).resolves.toBeUndefined();
  });

  it('defaults an omitted sandbox.mapState to () => "unknown"', async () => {
    const provider = build(
      { ...ALL_OFF, lifecycle: true, services: true },
      LIFECYCLE_MEMBERS,
    );
    const sbox = provider.sandboxes.get("sb_1");
    await expect(sbox.getState()).resolves.toBe("running");
    // mapState falls back to the safe default when the def omits it.
    expect(sbox.mapState("x")).toBe("unknown");
  });

  it("derives streaming support from whether `stream` is provided", async () => {
    // exec without streaming: streamExec rejects as unsupported.
    const noStream = build(
      { ...ALL_OFF, exec: true },
      {
        exec: { run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }) },
      },
    );
    await expect(noStream.sandboxes.get("sb_1").exec("ls")).resolves.toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    await expect(
      noStream.sandboxes.get("sb_1").streamExec("ls", { onStdout: () => {} }),
    ).rejects.toBeInstanceOf(SandboxProviderUnsupportedError);

    // exec with streaming: streamExec delegates.
    const streamedChunks: string[] = [];
    const streamed = build(
      { ...ALL_OFF, exec: true, streaming: true },
      {
        exec: {
          run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          stream: async (_id, _cmd, handlers) => {
            handlers.onStdout("chunk");
          },
        },
      },
    );
    await streamed.sandboxes.get("sb_1").streamExec("ls", {
      onStdout: (chunk) => streamedChunks.push(chunk),
    });
    expect(streamedChunks).toEqual(["chunk"]);
  });

  it("assembles file reads and SSH minting from their method pairs", async () => {
    const provider = build(
      { ...ALL_OFF, ssh: true },
      {
        files: { read: async () => "contents", write: async () => {} },
        ssh: {
          mint: async () => ({
            token: "t",
            sshDestination: "u@h",
            expiresAt: new Date(0),
          }),
          revoke: async () => {},
        },
      },
    );
    const sbox = provider.sandboxes.get("sb_1");
    await expect(sbox.readFile("/f")).resolves.toBe("contents");
    expect(sbox.ssh).not.toBeNull();
    await expect(sbox.ssh?.mint(60)).resolves.toMatchObject({ token: "t" });
  });

  it("routes git.clone to an author-provided clone primitive", async () => {
    const cloned: unknown[] = [];
    const provider = build(
      { ...ALL_OFF, lifecycle: true, services: true },
      {
        ...LIFECYCLE_MEMBERS,
        cloneRepo: async (id, input) => {
          cloned.push({ id, input });
        },
      },
    );
    const git = provider.sandboxes.get("sb_1").git;
    expect(git).not.toBeNull();
    await git!.clone({
      homeDir: "/home/amika",
      githubUrl: "https://github.com/x/y",
    });
    expect(cloned).toEqual([
      {
        id: "sb_1",
        input: { homeDir: "/home/amika", githubUrl: "https://github.com/x/y" },
      },
    ]);
  });
});
