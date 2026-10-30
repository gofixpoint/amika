import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_ORG_ID_LABEL } from "../../constants";
import { moduleLogger, type SandboxCtx } from "../../logger";
import {
  getProviderLabel,
  isSandboxProviderName,
  SANDBOX_PROVIDER_CAPABILITIES,
} from "../capabilities";
import {
  createSandboxProvider,
  getSandboxAdapter,
  type SandboxProviderDeps,
} from "../registry";
import {
  getSimulateWorld,
  resetSimulateWorlds,
  SimulateFaultError,
  SimulateNotFoundError,
} from "./provider";
import { SIMULATE_HOST_SUFFIX } from "./internal/operations";

import {
  SandboxFileTooLargeError,
  ScrubRestoreError,
  ScrubVerificationError,
} from "../provider";

const WORLD_ID = "provider-test";

const DEPS: SandboxProviderDeps = {
  daytona: { apiKey: "", apiUrl: "" },
  e2b: null,
  freestyle: null,
  vercel: null,
  smol: null,
  amikaHostd: null,
  simulate: { worldId: WORLD_ID },
  resolveSnapshotId: async () => null,
};

const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };

function provider() {
  return createSandboxProvider("simulate", DEPS);
}

async function createSandbox(name = "demo") {
  return provider().sandboxes.create(ctx, {
    name,
    snapshot: "base",
    services: [
      {
        name: "web",
        url: "",
        hostPort: 0,
        containerPort: 3000,
        protocol: "tcp",
      },
    ],
    labels: { [SANDBOX_ORG_ID_LABEL]: "org_1" },
    autoStopInterval: 30,
  });
}

afterEach(() => {
  resetSimulateWorlds();
});

describe("simulate provider wiring", () => {
  it("is recognized and has client-safe display data", () => {
    expect(isSandboxProviderName("simulate")).toBe(true);
    expect(getProviderLabel("simulate")).toBe("Simulated");
  });

  it("advertises the full contract except docker registries", () => {
    expect(SANDBOX_PROVIDER_CAPABILITIES.simulate).toEqual({
      lifecycle: true,
      ssh: true,
      services: true,
      exec: true,
      listSandboxes: true,
      streaming: true,
      snapshots: true,
      fullSnapshotCapture: true,
      scrubCapture: true,
      dockerRegistries: false,
      snapshotIdsAreOpaque: false,
      supportsAutoDelete: true,
      guestProvisioning: true,
    });
  });

  it("requires its config slice", () => {
    expect(() =>
      createSandboxProvider("simulate", { ...DEPS, simulate: null }),
    ).toThrow(/SIMULATE_ENABLED/);
  });

  it("shares one world across providers built with the same worldId", async () => {
    const sandbox = await createSandbox();
    const again = createSandboxProvider("simulate", DEPS);
    expect(await again.sandboxes.get(sandbox.id).getState()).toBe("running");
    expect(getSimulateWorld(WORLD_ID).vm(sandbox.id)?.name).toBe("demo");
  });
});

describe("simulate sandbox lifecycle", () => {
  it("creates a running sandbox stamped with the org label", async () => {
    const sandbox = await createSandbox();
    expect(sandbox.id).toBe("sim-vm-000001");
    expect(sandbox.created?.provider).toBe("simulate");
    expect(await sandbox.getRuntimeState()).toBe("running");

    const [listing] = await provider().sandboxes.list();
    expect(listing).toEqual({
      providerSandboxId: sandbox.id,
      orgId: "org_1",
      state: "running",
      sizing: { vcpus: 2, memoryGib: 4, diskGib: 10 },
    });
  });

  it("stops, starts, and deletes", async () => {
    const sandbox = await createSandbox();
    await sandbox.stop();
    expect(await sandbox.getRuntimeState()).toBe("stopped");
    await sandbox.start();
    expect(await sandbox.getRuntimeState()).toBe("running");
    await sandbox.delete();
    await expect(sandbox.getState()).rejects.toThrow(SimulateNotFoundError);
    expect(await provider().sandboxes.list()).toEqual([]);
  });

  it("runs scripted commands and records every call", async () => {
    const sandbox = await createSandbox();
    const world = getSimulateWorld(WORLD_ID);
    world.onExec("whoami", { exitCode: 0, stdout: "amika\n", stderr: "" });
    world.onExec(/^git /, (call) => ({
      exitCode: 128,
      stdout: "",
      stderr: `fatal: ${call.command}`,
    }));

    expect(await sandbox.exec("whoami")).toEqual({
      exitCode: 0,
      stdout: "amika\n",
      stderr: "",
    });
    expect((await sandbox.exec("git clone x")).exitCode).toBe(128);
    expect(await sandbox.exec("true")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(world.execLog.map((c) => c.command)).toEqual([
      "whoami",
      "git clone x",
      "true",
    ]);
  });

  it("streams a command's output to the handlers", async () => {
    const sandbox = await createSandbox();
    getSimulateWorld(WORLD_ID).onExec("build", {
      exitCode: 0,
      stdout: "out",
      stderr: "err",
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    await sandbox.streamExec("build", {
      onStdout: (c) => stdout.push(c),
      onStderr: (c) => stderr.push(c),
    });
    expect(stdout).toEqual(["out"]);
    expect(stderr).toEqual(["err"]);
  });

  it("refuses to exec in a stopped sandbox", async () => {
    const sandbox = await createSandbox();
    await sandbox.stop();
    await expect(sandbox.exec("true")).rejects.toThrow(/not running/);
  });

  it("reads and writes files through the sandbox and the adapter", async () => {
    const sandbox = await createSandbox();
    expect(await sandbox.readFile("/home/amika/.bashrc")).toBeNull();
    await sandbox.writeFile("/home/amika/.bashrc", "export A=1");
    expect(await sandbox.readFile("/home/amika/.bashrc")).toBe("export A=1");

    const adapter = await getSandboxAdapter("simulate", DEPS, sandbox.id);
    expect(await adapter.downloadFile("/home/amika/.bashrc")).toBe(
      "export A=1",
    );
    await adapter.uploadFile(Buffer.from("bytes"), "/tmp/bin");
    expect(await sandbox.readFile("/tmp/bin")).toBe("bytes");
    expect(await adapter.downloadFile("/missing")).toBeNull();
  });

  it("mints deterministic service URLs and reconciles routes", async () => {
    const sandbox = await createSandbox();
    const services = sandbox.created?.services ?? [];
    const refreshed = await sandbox.services?.refreshAll(services);
    expect(refreshed?.services[0].url).toBe(
      `http://${sandbox.id}-3000.${SIMULATE_HOST_SUFFIX}`,
    );
    expect(refreshed?.services[0].hostPort).toBe(3000);

    const loaded = sandbox.services?.load(services);
    await loaded?.get(3000)?.revoke();
    expect(getSimulateWorld(WORLD_ID).vm(sandbox.id)?.routes).toEqual([]);
  });

  it("mints and revokes ssh access", async () => {
    const sandbox = await createSandbox();
    const world = getSimulateWorld(WORLD_ID);
    world.freezeTime(1_000_000);
    const access = await sandbox.ssh!.mint(15);
    expect(access.sshDestination).toBe(
      `amika@${sandbox.id}.${SIMULATE_HOST_SUFFIX}`,
    );
    expect(access.expiresAt.getTime()).toBe(1_000_000 + 15 * 60_000);
    expect(world.sshTokensFor(sandbox.id)).toEqual([access.token]);
    await access.revoke();
    expect(world.sshTokensFor(sandbox.id)).toEqual([]);
  });
});

describe("simulate snapshots", () => {
  it("captures a sandbox's files into a snapshot a new sandbox boots from", async () => {
    const p = provider();
    const source = await createSandbox("source");
    await source.writeFile("/home/amika/notes.txt", "kept");

    const snapshot = await source.snapshots!.create("org_1/notes");
    expect(snapshot.name).toBe("org_1/notes");
    expect(snapshot.providerSnapshotId).toBeNull();
    // A full capture keeps the source running.
    expect(await source.getRuntimeState()).toBe("running");

    expect((await p.snapshots!.get("org_1/notes"))?.state).toBe("active");
    expect(await p.snapshots!.get("missing")).toBeNull();

    const restored = await p.sandboxes.create(ctx, {
      name: "restored",
      snapshot: "org_1/notes",
      services: [],
    });
    expect(await restored.readFile("/home/amika/notes.txt")).toBe("kept");

    await snapshot.delete();
    expect(await p.snapshots!.get("org_1/notes")).toBeNull();
  });

  it("registers an image as a snapshot once", async () => {
    const p = provider();
    const image = { name: "base-image", image: "ubuntu:24.04" };
    expect((await p.snapshots!.createImage(image))?.imageName).toBe(
      "ubuntu:24.04",
    );
    expect(await p.snapshots!.createImage(image)).toBeNull();
    expect(await p.snapshots!.find("base-image")).not.toBeNull();
  });

  it("reports whether the sandbox was created scrub safe", async () => {
    const sandbox = await createSandbox();
    expect(await sandbox.snapshots!.isEnvScrubbable()).toBe(false);
    const safe = await provider().sandboxes.create(ctx, {
      name: "safe",
      snapshot: "base",
      services: [],
      scrubSafe: true,
    });
    expect(await safe.snapshots!.isEnvScrubbable()).toBe(true);
  });
});

describe("simulate faults", () => {
  it("fails the next create once, then recovers", async () => {
    const world = getSimulateWorld(WORLD_ID);
    world.failNext("create", "quota exceeded");
    await expect(createSandbox()).rejects.toThrow(SimulateFaultError);
    const sandbox = await createSandbox();
    expect(sandbox.id).toBe("sim-vm-000001");
  });

  it("fails an operation on every call until cleared", async () => {
    const sandbox = await createSandbox();
    const world = getSimulateWorld(WORLD_ID);
    world.failAlways("exec");
    await expect(sandbox.exec("true")).rejects.toThrow(SimulateFaultError);
    await expect(sandbox.exec("true")).rejects.toThrow(SimulateFaultError);
    world.clearFaults("exec");
    expect((await sandbox.exec("true")).exitCode).toBe(0);
  });

  it("drops a vanished sandbox from listings and fails later calls on it", async () => {
    const sandbox = await createSandbox();
    const other = await createSandbox("other");
    getSimulateWorld(WORLD_ID).vanish(sandbox.id);
    expect(
      (await provider().sandboxes.list()).map((l) => l.providerSandboxId),
    ).toEqual([other.id]);
    await expect(sandbox.getState()).rejects.toThrow(SimulateNotFoundError);
    await expect(sandbox.exec("true")).rejects.toThrow(SimulateNotFoundError);
  });
});

describe("simulate contract regressions", () => {
  it("enforces byte limits including exact-size and empty files", async () => {
    const sandbox = await createSandbox();
    await sandbox.writeFile("/f", "abcdef");
    await expect(sandbox.readFileBytes("/f", { maxBytes: 5 })).rejects.toThrow(
      SandboxFileTooLargeError,
    );
    expect(await sandbox.readFileBytes("/f", { maxBytes: 6 })).toHaveLength(6);
    expect(await sandbox.readFileBytes("/missing", { maxBytes: 0 })).toBeNull();
    await sandbox.writeFile("/empty", "");
    expect(await sandbox.readFileBytes("/empty", { maxBytes: 0 })).toHaveLength(
      0,
    );
  });

  it.each([/whoami/g, /whoami/y])(
    "repeats stateful matcher %s",
    async (matcher) => {
      const sandbox = await createSandbox();
      getSimulateWorld(WORLD_ID).onExec(matcher, {
        exitCode: 0,
        stdout: "amika",
        stderr: "",
      });
      for (let i = 0; i < 3; i++)
        expect((await sandbox.exec("whoami")).stdout).toBe("amika");
    },
  );

  it("scrubs files, directories, baselines and git remotes before capture", async () => {
    const sandbox = await createSandbox();
    const secret = "/home/amika/it's secret";
    const root = "/work/it's a repo";
    const config = `${root}/project/.git/config`;
    await sandbox.writeFile(`${secret}/token`, "credential");
    await sandbox.writeFile(`${secret}-kept`, "kept");
    await sandbox.writeFile("/etc/secret", "credential");
    await sandbox.writeFile("/etc/environment", "TOKEN=secret");
    await sandbox.writeFile("/baseline", "PATH=/bin");
    await sandbox.writeFile(
      config,
      "url = https://x-access-token:secret@github.com/org/repo.git",
    );
    await sandbox.snapshots!.scrubAndCreate("scrubbed", {
      files: [secret],
      sudoFiles: ["/etc/secret"],
      sudoFileRestores: [
        { sourcePath: "/baseline", destinationPath: "/etc/environment" },
      ],
      envVarNames: ["TOKEN"],
      gitTokenWorkspaceRoot: root,
    });
    const restored = await provider().sandboxes.create(ctx, {
      name: "restored",
      snapshot: "scrubbed",
      services: [],
    });
    expect(await restored.readFile(`${secret}/token`)).toBeNull();
    expect(await restored.readFile(`${secret}-kept`)).toBe("kept");
    expect(await restored.readFile("/etc/secret")).toBeNull();
    expect(await restored.readFile("/etc/environment")).toBe("PATH=/bin");
    expect(await restored.readFile(config)).toBe(
      "url = https://github.com/org/repo.git",
    );
  });

  it("fails capture when a scrub baseline is missing", async () => {
    const sandbox = await createSandbox();
    await expect(
      sandbox.snapshots!.scrubAndCreate("bad", {
        files: [],
        sudoFiles: [],
        envVarNames: [],
        sudoFileRestores: [
          { sourcePath: "/missing", destinationPath: "/etc/environment" },
        ],
      }),
    ).rejects.toThrow(ScrubRestoreError);
    expect(getSimulateWorld(WORLD_ID).snapshot("bad")).toBeUndefined();
  });

  it("verification catches a scripted removal that does nothing", async () => {
    const sandbox = await createSandbox();
    await sandbox.writeFile("/secret", "credential");
    getSimulateWorld(WORLD_ID).onExec(/^rm /, {
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await expect(
      sandbox.snapshots!.scrubAndCreate("bad", {
        files: ["/secret"],
        sudoFiles: [],
        sudoFileRestores: [],
        envVarNames: [],
      }),
    ).rejects.toThrow(ScrubVerificationError);
    expect(getSimulateWorld(WORLD_ID).snapshot("bad")).toBeUndefined();
  });
});
