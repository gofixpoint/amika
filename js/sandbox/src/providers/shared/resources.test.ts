import { describe, expect, it, vi } from "vitest";
import { defineProvider, type ProviderDefinition } from "./define-provider";
import {
  SandboxProviderUnsupportedError,
  type ExecCommandOptions,
  type ProviderSnapshot,
  type SandboxProvider,
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

const ALL_ON: SandboxProviderCapabilities = {
  lifecycle: true,
  ssh: true,
  services: true,
  exec: true,
  listSandboxes: true,
  streaming: true,
  snapshots: true,
  scrubCapture: true,
  fullSnapshotCapture: true,
  dockerRegistries: true,
  skipStartScript: false,
  snapshotIdsAreOpaque: false,
  supportsAutoDelete: false,
};

/** A fully-capable definition whose every method is a spy we can assert on. */
function fullDef() {
  const spies = {
    create: vi.fn(async () => ({
      provider: "daytona" as const,
      providerSandboxId: "sb_new",
      providerUrl: "https://sb_new",
      services: [],
    })),
    delete: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn(async () => "started"),
    mapState: vi.fn(() => "running" as const),
    run: vi.fn(
      async (_id: string, _cmd: string, _opts?: ExecCommandOptions) => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
    ),
    stream: vi.fn(async () => {}),
    read: vi.fn(async () => "contents"),
    write: vi.fn(async () => {}),
    mint: vi.fn(async () => ({
      token: "tok",
      sshDestination: "u@h",
      expiresAt: new Date(0),
    })),
    revoke: vi.fn(async () => {}),
    refreshUrls: vi.fn(async () => ({
      providerUrl: "https://x",
      services: [],
    })),
    syncRoutes: vi.fn(async () => {}),
    list: vi.fn(async () => [
      {
        providerSandboxId: "sb_a",
        orgId: "o",
        state: "running",
        sizing: { vcpus: 1, memoryGib: 2, diskGib: 32 },
      },
    ]),
    cloneRepo: vi.fn(async () => {}),
    capture: vi.fn(
      async (
        _id: string,
        _name: string,
        opts: { keepSourceRunning: boolean },
      ) =>
        opts.keepSourceRunning
          ? { providerSnapshotId: "snap_id" }
          : { providerSnapshotId: "snap_scrub" },
    ),
    removeInjectedSecrets: vi.fn(async () => {}),
    isEnvScrubbable: vi.fn(async () => true),
    waitForSnapshotActive: vi.fn(async (name: string) => ({
      name,
      state: "active",
    })),
    deleteSnapshot: vi.fn(async () => {}),
    getSnapshot: vi.fn(async (): Promise<ProviderSnapshot | null> => null),
    findSnapshot: vi.fn(async (): Promise<ProviderSnapshot | null> => null),
    createImageSnapshot: vi.fn(
      async (): Promise<ProviderSnapshot | null> => null,
    ),
    createRegistry: vi.fn(async () => registryDto("reg_1")),
    listRegistries: vi.fn(async () => [
      registryDto("reg_1"),
      registryDto("reg_2"),
    ]),
    getRegistry: vi.fn(async (id: string) => registryDto(id)),
    deleteRegistry: vi.fn(async () => {}),
  };

  const def: ProviderDefinition = {
    name: "daytona",
    signedUrlTtlSeconds: 60,
    userHomeDir: "/home/amika",
    sandbox: {
      create: spies.create,
      delete: spies.delete,
      start: spies.start,
      stop: spies.stop,
      getState: spies.getState,
      mapState: spies.mapState,
    },
    cloneRepo: spies.cloneRepo,
    exec: { run: spies.run, stream: spies.stream },
    files: { read: spies.read, write: spies.write },
    ssh: { mint: spies.mint, revoke: spies.revoke },
    services: {
      refreshUrls: spies.refreshUrls,
      syncRoutes: spies.syncRoutes,
    },
    listing: { list: spies.list },
    snapshots: {
      createImageSnapshot: spies.createImageSnapshot,
      getSnapshot: spies.getSnapshot,
      findSnapshot: spies.findSnapshot,
      deleteSnapshot: spies.deleteSnapshot,
      waitForSnapshotActive: spies.waitForSnapshotActive,
      capture: spies.capture,
      removeInjectedSecrets: spies.removeInjectedSecrets,
      isEnvScrubbable: spies.isEnvScrubbable,
    },
    dockerRegistries: {
      createRegistry: spies.createRegistry,
      listRegistries: spies.listRegistries,
      getRegistry: spies.getRegistry,
      deleteRegistry: spies.deleteRegistry,
    },
  };
  return { def, spies };
}

function svc(name: string, containerPort: number) {
  return {
    name,
    url: "",
    hostPort: 0,
    containerPort,
    protocol: "tcp" as const,
  };
}

function registryDto(id: string) {
  return {
    id,
    name: `name-${id}`,
    url: "https://reg",
    username: "u",
    registryType: "harbor",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function fullProvider(): {
  provider: SandboxProvider;
  spies: ReturnType<typeof fullDef>["spies"];
} {
  const { def, spies } = fullDef();
  return { provider: defineProvider(ALL_ON, () => def)({}), spies };
}

/** A create/delete-only provider: every richer capability is absent. */
function minimalProvider(): SandboxProvider {
  const def: ProviderDefinition = {
    name: "daytona",
    signedUrlTtlSeconds: 0,
    userHomeDir: "/home/amika",
    sandbox: {
      create: async () => ({
        provider: "daytona",
        providerSandboxId: "sb_1",
        providerUrl: null,
        services: [],
      }),
      delete: async () => {},
    },
  };
  return defineProvider(ALL_OFF, () => def)({});
}

describe("sandboxes namespace", () => {
  it("get() returns a lightweight ref without I/O", () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_x");
    expect(sandbox.id).toBe("sb_x");
    expect(sandbox.provider).toBe("daytona");
    expect(sandbox.created).toBeUndefined();
    // No capability was touched just resolving the ref.
    expect(spies.getState).not.toHaveBeenCalled();
  });

  it("create() returns a Sandbox carrying the create result", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = await provider.sandboxes.create({} as never, {} as never);
    expect(spies.create).toHaveBeenCalledOnce();
    expect(sandbox.id).toBe("sb_new");
    expect(sandbox.created).toEqual({
      provider: "daytona",
      providerSandboxId: "sb_new",
      providerUrl: "https://sb_new",
      services: [],
    });
  });

  it("list() delegates to the listing capability", async () => {
    const { provider, spies } = fullProvider();
    const listed = await provider.sandboxes.list();
    expect(spies.list).toHaveBeenCalledOnce();
    expect(listed[0]?.providerSandboxId).toBe("sb_a");
  });
});

describe("Sandbox methods delegate to capabilities", () => {
  it("start/stop/delete/getState/mapState/getRuntimeState", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    await sandbox.start(30);
    expect(spies.start).toHaveBeenCalledWith("sb_1", 30);
    await sandbox.stop();
    expect(spies.stop).toHaveBeenCalledWith("sb_1");
    await sandbox.delete();
    expect(spies.delete).toHaveBeenCalledWith("sb_1");
    await expect(sandbox.getState()).resolves.toBe("started");
    expect(sandbox.mapState("started")).toBe("running");
    expect(spies.mapState).toHaveBeenCalledWith("started");
    await expect(sandbox.getRuntimeState()).resolves.toBe("running");
  });

  it("exec/streamExec/readFile/writeFile/git.clone", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    await expect(sandbox.exec("ls", { cwd: "/w" })).resolves.toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(spies.run).toHaveBeenCalledWith("sb_1", "ls", { cwd: "/w" });
    const handlers = { onStdout: () => {} };
    await sandbox.streamExec("tail", handlers);
    expect(spies.stream).toHaveBeenCalledWith("sb_1", "tail", handlers);
    await expect(sandbox.readFile("/f")).resolves.toBe("contents");
    expect(spies.read).toHaveBeenCalledWith("sb_1", "/f");
    await sandbox.writeFile("/f", "data");
    expect(spies.write).toHaveBeenCalledWith("sb_1", "/f", "data");
    await sandbox.git!.clone({ homeDir: "/h", githubUrl: "https://g/r" });
    expect(spies.cloneRepo).toHaveBeenCalledWith("sb_1", {
      homeDir: "/h",
      githubUrl: "https://g/r",
    });
  });
});

describe("Sandbox sub-namespaces", () => {
  it("ssh.mint() returns a handle whose revoke() is bound to the token", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    const access = await sandbox.ssh!.mint(60, []);
    expect(spies.mint).toHaveBeenCalledWith("sb_1", 60, []);
    expect(access.token).toBe("tok");
    await access.revoke();
    expect(spies.revoke).toHaveBeenCalledWith("sb_1", "tok");
  });

  it("ssh.revoke(token) revokes a persisted token directly", async () => {
    const { provider, spies } = fullProvider();
    await provider.sandboxes.get("sb_1").ssh!.revoke("stored-token");
    expect(spies.revoke).toHaveBeenCalledWith("sb_1", "stored-token");
  });

  it("services.refreshAll() delegates without touching routes", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    await sandbox.services!.refreshAll([]);
    expect(spies.refreshUrls).toHaveBeenCalledWith("sb_1", []);
    expect(spies.syncRoutes).not.toHaveBeenCalled();
  });

  it("services.load(): get by port, revoke = set minus me, update = replaced set", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    const web = svc("web", 3000);
    const agent = svc("Coding Agent", 60998);
    const loaded = sandbox.services!.load([agent, web]);

    expect(loaded.list().map((s) => s.name)).toEqual(["Coding Agent", "web"]);
    expect(loaded.get(4000)).toBeNull();

    // revoke: routes reconcile to the loaded set minus the revoked service.
    await loaded.get(3000)!.revoke();
    expect(spies.syncRoutes).toHaveBeenCalledWith("sb_1", [agent]);

    // update: routes reconcile to the set with the replacement in place, then
    // URLs re-mint over that same set.
    const next = svc("web-v2", 3001);
    await loaded.get(3000)!.update(next);
    expect(spies.syncRoutes).toHaveBeenLastCalledWith("sb_1", [agent, next]);
    expect(spies.refreshUrls).toHaveBeenCalledWith("sb_1", [agent, next]);
  });

  it("services.load().refresh() reconciles routes then re-mints", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    const set = [svc("Coding Agent", 60998), svc("late", 4000)];
    await sandbox.services!.load(set).refresh();
    expect(spies.syncRoutes).toHaveBeenCalledWith("sb_1", set);
    expect(spies.refreshUrls).toHaveBeenCalledWith("sb_1", set);
    // Ordering: routes must exist before URLs are minted against them.
    expect(spies.syncRoutes.mock.invocationCallOrder[0]!).toBeLessThan(
      spies.refreshUrls.mock.invocationCallOrder[0]!,
    );
  });

  it("services.load() revoke keeps a shared port claimed by another entry", async () => {
    // Legacy sets can carry two services on one port; identity is positional,
    // so revoking one leaves the other (and thus the port) in the desired set.
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    const first = svc("web", 3000);
    const twin = svc("web-twin", 3000);
    const loaded = sandbox.services!.load([first, twin]);
    // get() returns the first match on the duplicated port...
    expect(loaded.get(3000)!.name).toBe("web");
    await loaded.get(3000)!.revoke();
    // ...and the twin keeps the port desired.
    expect(spies.syncRoutes).toHaveBeenCalledWith("sb_1", [twin]);
  });

  it("snapshots.create() captures and returns a Snapshot with waitForActive/delete", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    const snap = await sandbox.snapshots!.create("org/snap");
    expect(spies.capture).toHaveBeenCalledWith("sb_1", "org/snap", {
      keepSourceRunning: true,
    });
    expect(snap.name).toBe("org/snap");
    expect(snap.providerSnapshotId).toBe("snap_id");
    // The bound ops pass the captured bootable handle alongside the name, so
    // an id-only provider (Vercel) can act before the control plane records
    // the name↔id mapping.
    const active = await snap.waitForActive();
    expect(spies.waitForSnapshotActive).toHaveBeenCalledWith(
      "org/snap",
      "snap_id",
    );
    expect(active.state).toBe("active");
    await snap.delete();
    expect(spies.deleteSnapshot).toHaveBeenCalledWith("org/snap", "snap_id");
  });

  it("snapshots.scrubAndCreate() scrubs via exec, runs the provider hook, captures with delete-intent", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    // Removal commands succeed; the `ls -1d` verification finds nothing left.
    spies.run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const targets = {
      files: ["/home/amika/.claude"],
      sudoFiles: ["/etc/environment"],
      sudoFileRestores: [],
      envVarNames: ["E"],
    };
    const result = await sandbox.snapshots!.scrubAndCreate("org/snap", targets);
    // The scrub ran through the exec primitive (rm + rm + verify)...
    expect(spies.run).toHaveBeenCalledTimes(3);
    expect(spies.run.mock.calls[0]?.[1]).toContain(".claude");
    // ...every scrub command resumes bare so a stopped Vercel sandbox can't
    // relaunch services with the secret being scrubbed...
    for (const call of spies.run.mock.calls) {
      expect(call[2]).toMatchObject({ resumeMode: "bare" });
    }
    // ...then the provider removed its own injected secrets and captured with
    // delete-intent.
    expect(spies.removeInjectedSecrets).toHaveBeenCalledWith("sb_1");
    expect(spies.capture).toHaveBeenCalledWith("sb_1", "org/snap", {
      keepSourceRunning: false,
    });
    // Security-critical ordering: every scrub command AND the provider's
    // injected-secret removal MUST run before the capture freezes the
    // filesystem, or the snapshot retains the very secrets being removed
    // (e.g. Vercel's resume-context password file).
    const lastScrubCmd = Math.max(...spies.run.mock.invocationCallOrder);
    const hookOrder = spies.removeInjectedSecrets.mock.invocationCallOrder[0]!;
    const captureOrder = spies.capture.mock.invocationCallOrder[0]!;
    expect(lastScrubCmd).toBeLessThan(hookOrder);
    expect(hookOrder).toBeLessThan(captureOrder);
    expect(result.removedFiles).toEqual(["/home/amika/.claude"]);
    expect(result.removedEnvVars).toEqual(["E"]);
    expect(result.snapshot.name).toBe("org/snap");
    expect(result.snapshot.providerSnapshotId).toBe("snap_scrub");
    await result.snapshot.delete();
    expect(spies.deleteSnapshot).toHaveBeenCalledWith("org/snap", "snap_scrub");
  });

  it("snapshots.scrubAndCreate() fails closed when scrubbed paths persist", async () => {
    const { provider, spies } = fullProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    // rm succeeds but the verification still lists the path — abort before any
    // capture so no secret-bearing snapshot is produced.
    spies.run.mockResolvedValue({
      exitCode: 0,
      stdout: "/home/amika/.claude",
      stderr: "",
    });
    await expect(
      sandbox.snapshots!.scrubAndCreate("org/snap", {
        files: ["/home/amika/.claude"],
        sudoFiles: [],
        sudoFileRestores: [],
        envVarNames: [],
      }),
    ).rejects.toThrow(/Scrub verification failed/);
    expect(spies.capture).not.toHaveBeenCalled();
    expect(spies.removeInjectedSecrets).not.toHaveBeenCalled();
  });

  it("snapshots.scrubAndCreate() throws unsupported without exec", async () => {
    // `snapshots` and `exec` are independently declarable; the synthesized
    // scrub runs through exec, so a snapshots-without-exec provider offers
    // only the raw captures (mirrored by `capabilities.scrubCapture`).
    const { def, spies } = fullDef();
    const provider = defineProvider(
      { ...ALL_ON, exec: false, streaming: false, scrubCapture: false },
      () => ({ ...def, exec: null }),
    )({});
    await expect(
      provider.sandboxes.get("sb_1").snapshots!.scrubAndCreate("org/snap", {
        files: [],
        sudoFiles: [],
        sudoFileRestores: [],
        envVarNames: [],
      }),
    ).rejects.toThrow(/does not support operation "scrubAndCreate"/);
    expect(spies.capture).not.toHaveBeenCalled();
    // The raw keep-source capture still works without exec.
    await provider.sandboxes.get("sb_1").snapshots!.create("org/snap");
    expect(spies.capture).toHaveBeenCalledWith("sb_1", "org/snap", {
      keepSourceRunning: true,
    });
  });

  it("snapshots.isEnvScrubbable() delegates", async () => {
    const { provider, spies } = fullProvider();
    await expect(
      provider.sandboxes.get("sb_1").snapshots!.isEnvScrubbable(),
    ).resolves.toBe(true);
    expect(spies.isEnvScrubbable).toHaveBeenCalledWith("sb_1");
  });
});

describe("snapshots namespace (provider.snapshots)", () => {
  it("get()/find() wrap a hit in a Snapshot and preserve the null contract", async () => {
    const { provider, spies } = fullProvider();
    spies.getSnapshot.mockResolvedValueOnce({
      name: "org/snap",
      providerSnapshotId: "snap_1",
      state: "active",
    });
    const snap = await provider.snapshots!.get("org/snap");
    expect(snap?.state).toBe("active");
    // Bound delete forwards the captured provider handle alongside the name.
    await snap!.delete();
    expect(spies.deleteSnapshot).toHaveBeenCalledWith("org/snap", "snap_1");
    await expect(provider.snapshots!.get("missing")).resolves.toBeNull();

    spies.findSnapshot.mockResolvedValueOnce({ name: "org/snap2" });
    const found = await provider.snapshots!.find("org/snap2");
    expect(found?.name).toBe("org/snap2");
    await expect(provider.snapshots!.find("missing")).resolves.toBeNull();
  });

  it("createImage() preserves the already-exists null contract", async () => {
    const { provider, spies } = fullProvider();
    await expect(
      provider.snapshots!.createImage({ name: "org/img:tag", image: "i:t" }),
    ).resolves.toBeNull();

    spies.createImageSnapshot.mockResolvedValueOnce({
      name: "org/img:tag",
      state: "building",
    });
    const created = await provider.snapshots!.createImage({
      name: "org/img:tag",
      image: "i:t",
    });
    expect(created?.name).toBe("org/img:tag");
    const active = await created!.waitForActive();
    expect(spies.waitForSnapshotActive).toHaveBeenCalledWith(
      "org/img:tag",
      undefined,
    );
    expect(active.state).toBe("active");
  });

  it("is null on a provider without the capability", () => {
    expect(minimalProvider().snapshots).toBeNull();
  });
});

describe("docker namespace", () => {
  it("registries.create/list/get return DockerRegistry objects with delete()", async () => {
    const { provider, spies } = fullProvider();
    const created = await provider.docker!.registries.create({
      name: "n",
      url: "https://reg",
      username: "u",
      password: "p",
    });
    expect(spies.createRegistry).toHaveBeenCalledOnce();
    expect(created.id).toBe("reg_1");
    await created.delete();
    expect(spies.deleteRegistry).toHaveBeenCalledWith("reg_1");

    const all = await provider.docker!.registries.list();
    expect(all.map((r) => r.id)).toEqual(["reg_1", "reg_2"]);

    const got = await provider.docker!.registries.get("reg_9");
    expect(spies.getRegistry).toHaveBeenCalledWith("reg_9");
    expect(got.id).toBe("reg_9");
  });
});

describe("unsupported operations on a minimal provider", () => {
  it("null sub-namespaces and throwing run-state/exec/files ops", async () => {
    const provider = minimalProvider();
    const sandbox = provider.sandboxes.get("sb_1");
    expect(sandbox.git).toBeNull();
    expect(sandbox.ssh).toBeNull();
    expect(sandbox.services).toBeNull();
    expect(sandbox.snapshots).toBeNull();
    expect(provider.docker).toBeNull();
    await expect(sandbox.start()).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    await expect(sandbox.exec("ls")).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    await expect(sandbox.readFile("/f")).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
    // delete stays available — it's the always-present capability.
    await expect(sandbox.delete()).resolves.toBeUndefined();
    await expect(provider.sandboxes.list()).rejects.toBeInstanceOf(
      SandboxProviderUnsupportedError,
    );
  });

  it("streamExec throws when exec has no stream", async () => {
    const def: ProviderDefinition = {
      name: "daytona",
      signedUrlTtlSeconds: 0,
      userHomeDir: "/home/amika",
      sandbox: {
        create: async () => ({
          provider: "daytona",
          providerSandboxId: "sb_1",
          providerUrl: null,
          services: [],
        }),
        delete: async () => {},
      },
      exec: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    };
    const provider = defineProvider({ ...ALL_OFF, exec: true }, () => def)({});
    await expect(
      provider.sandboxes.get("sb_1").streamExec("x", { onStdout: () => {} }),
    ).rejects.toBeInstanceOf(SandboxProviderUnsupportedError);
  });
});
