/**
 * The provider contract suite: one set of behavior checks that every sandbox
 * provider must pass.
 *
 * The suite talks to the provider through the public {@link SandboxProvider}
 * surface only, with no mocks. Each scenario is a short, linear script that a
 * reader can check against the contract in `../provider.ts`. Scenarios are
 * selected by the provider's capability flags: a flag set to `true` makes its
 * scenarios run and must pass; a flag set to `false` skips them. That turns
 * the flags into promises a provider keeps, not just metadata.
 *
 * Two entry points run the suite:
 *   - `contract.test.ts` runs it against `simulate` on every `pnpm test`.
 *   - `contract.integration.test.ts` runs it against a real vendor named by
 *     `TEST_SANDBOX_CONTRACT_PROVIDER`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Logger, SandboxCtx } from "../../logger";
import { SANDBOX_ORG_ID_LABEL } from "../../constants";
import type { SandboxService } from "../../types";
import { SANDBOX_PROVIDER_CAPABILITIES } from "../capabilities";
import {
  SandboxFileTooLargeError,
  type ExecCommandOptions,
  type Sandbox,
  type SandboxExecResult,
  type SandboxProvider,
  type Snapshot,
  type SnapshotIdResolver,
} from "../provider";

/** What the suite needs to know about the provider under test. */
export interface ProviderContractTarget {
  /**
   * Build the provider. The suite passes a `resolveSnapshotId` that maps a
   * snapshot name to the bootable id it recorded when it captured that
   * snapshot, so providers with opaque snapshot ids can look snapshots up.
   */
  createProvider(resolveSnapshotId: SnapshotIdResolver): SandboxProvider;
  /** A snapshot or image the provider can boot a sandbox from. */
  bootSnapshot: string;
  /**
   * Script the output of `command` before the suite runs it. Only a provider
   * with no real shell behind it needs this (`simulate`); a real vendor runs
   * the command and leaves this unset.
   */
  scriptExec?(command: string, result: SandboxExecResult): void;
  /**
   * How long to keep polling for a change the vendor applies asynchronously,
   * such as a deleted sandbox leaving the account listing. Default 0: check
   * once.
   */
  settleMs?: number;
}

/** The org id stamped on every sandbox the suite creates. */
const ORG_ID = "contract-org";
const SERVICE_PORT = 3000;

interface ExecCase {
  name: string;
  command: string;
  opts?: ExecCommandOptions;
  want: SandboxExecResult;
}

/** Shell commands every provider with `exec` must run the same way. */
const EXEC_CASES: ExecCase[] = [
  {
    name: "returns a command's stdout and a zero exit code",
    command: "echo hello",
    want: { exitCode: 0, stdout: "hello\n", stderr: "" },
  },
  {
    name: "returns a command's non-zero exit code",
    command: "exit 3",
    want: { exitCode: 3, stdout: "", stderr: "" },
  },
  {
    name: "keeps stderr separate from stdout",
    command: "echo oops 1>&2",
    want: { exitCode: 0, stdout: "", stderr: "oops\n" },
  },
  {
    name: "runs a command in the given working directory",
    command: "pwd",
    opts: { cwd: "/tmp" },
    want: { exitCode: 0, stdout: "/tmp\n", stderr: "" },
  },
  {
    name: "passes env vars to the command",
    command: "printf '%s\\n' \"$CONTRACT_VAR\"",
    opts: { env: { CONTRACT_VAR: "from-contract" } },
    want: { exitCode: 0, stdout: "from-contract\n", stderr: "" },
  },
];

/** Register the contract suite for `target`. */
export function describeProviderContract(target: ProviderContractTarget): void {
  // Snapshot name -> bootable id, filled in as the suite captures snapshots.
  const snapshotIds = new Map<string, string>();
  const provider = target.createProvider(
    async (name) => snapshotIds.get(name) ?? null,
  );
  const caps = provider.capabilities;
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  let sequence = 0;
  const uniqueName = (kind: string) =>
    `contract-${kind}-${runId}-${(sequence += 1)}`;

  // Everything created in a test, deleted in reverse order after it.
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const release of cleanup.splice(0).reverse()) {
      await release().catch((error: unknown) => {
        console.warn(`contract cleanup failed: ${String(error)}`);
      });
    }
  });

  async function createSandbox(
    overrides: { services?: SandboxService[]; scrubSafe?: boolean } = {},
    snapshot: string = target.bootSnapshot,
  ): Promise<Sandbox> {
    const sandbox = await provider.sandboxes.create(ctx, {
      name: uniqueName("sb"),
      snapshot,
      services: overrides.services ?? [],
      labels: { [SANDBOX_ORG_ID_LABEL]: ORG_ID },
      scrubSafe: overrides.scrubSafe,
    });
    cleanup.push(() => sandbox.delete());
    return sandbox;
  }

  /** Capture a snapshot, record its id, and schedule its deletion. */
  function trackSnapshot(snapshot: Snapshot): Snapshot {
    if (snapshot.providerSnapshotId) {
      snapshotIds.set(snapshot.name, snapshot.providerSnapshotId);
    }
    cleanup.push(() => snapshot.delete());
    return snapshot;
  }

  /** The value `create` accepts to boot from `snapshot`. */
  function bootRef(snapshot: Snapshot): string {
    if (!caps.snapshotIdsAreOpaque) return snapshot.name;
    expect(snapshot.providerSnapshotId).toBeTruthy();
    return snapshot.providerSnapshotId!;
  }

  function exec(
    sandbox: Sandbox,
    command: string,
    want: SandboxExecResult,
    opts?: ExecCommandOptions,
  ): Promise<SandboxExecResult> {
    target.scriptExec?.(command, want);
    return sandbox.exec(command, opts);
  }

  const eventually = <T>(check: () => Promise<T>) =>
    retryFor(target.settleMs ?? 0, check);

  describe(`${provider.name} provider contract`, () => {
    it("is registered with the capability flags it was built with", () => {
      expect(provider.capabilities).toEqual(
        SANDBOX_PROVIDER_CAPABILITIES[provider.name],
      );
    });

    it("names the sandbox user's home directory", () => {
      expect(provider.userHomeDir).toMatch(/^\//);
    });

    it("creates a sandbox and deletes it", async () => {
      const sandbox = await createSandbox();
      expect(sandbox.id).not.toBe("");
      expect(sandbox.provider).toBe(provider.name);
      expect(sandbox.created?.provider).toBe(provider.name);
      expect(sandbox.created?.providerSandboxId).toBe(sandbox.id);
      await sandbox.delete();
      // Deleting again is a no-op, not an error.
      await sandbox.delete();
    });

    describe.skipIf(!caps.lifecycle)("lifecycle", () => {
      it("is running after create", async () => {
        const sandbox = await createSandbox();
        expect(await sandbox.getRuntimeState()).toBe("running");
      });

      it.each(EXEC_CASES)("$name", async ({ command, opts, want }) => {
        const sandbox = await createSandbox();
        expect(await exec(sandbox, command, want, opts)).toEqual(want);
      });

      it("runs commands as the user whose home is userHomeDir", async () => {
        const sandbox = await createSandbox();
        const want = {
          exitCode: 0,
          stdout: `${provider.userHomeDir}\n`,
          stderr: "",
        };
        expect(await exec(sandbox, "printf '%s\\n' \"$HOME\"", want)).toEqual(
          want,
        );
      });

      it("stops and starts again", async () => {
        const sandbox = await createSandbox();
        await sandbox.stop();
        expect(await sandbox.getRuntimeState()).toBe("stopped");
        await sandbox.start();
        expect(await sandbox.getRuntimeState()).toBe("running");
        const want = { exitCode: 0, stdout: "back\n", stderr: "" };
        expect(await exec(sandbox, "echo back", want)).toEqual(want);
      });

      it("writes a file and reads it back", async () => {
        const sandbox = await createSandbox();
        const path = `${provider.userHomeDir}/contract.txt`;
        await sandbox.writeFile(path, "hello file");
        expect(await sandbox.readFile(path)).toBe("hello file");
      });

      it("reads a missing file as null", async () => {
        const sandbox = await createSandbox();
        expect(
          await sandbox.readFile(`${provider.userHomeDir}/missing.txt`),
        ).toBeNull();
      });

      it("round-trips binary file content", async () => {
        const sandbox = await createSandbox();
        const path = `${provider.userHomeDir}/contract.bin`;
        const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
        await sandbox.writeFile(path, bytes);
        expect(Buffer.from((await sandbox.readFileBytes(path))!)).toEqual(
          bytes,
        );
      });

      it("refuses to read a file larger than maxBytes", async () => {
        const sandbox = await createSandbox();
        const path = `${provider.userHomeDir}/big.txt`;
        await sandbox.writeFile(path, "0123456789");
        await expect(
          sandbox.readFileBytes(path, { maxBytes: 4 }),
        ).rejects.toThrow(SandboxFileTooLargeError);
      });

      it("keeps files across a stop and start", async () => {
        const sandbox = await createSandbox();
        const path = `${provider.userHomeDir}/kept.txt`;
        await sandbox.writeFile(path, "still here");
        await sandbox.stop();
        await sandbox.start();
        expect(await sandbox.readFile(path)).toBe("still here");
      });
    });

    describe.skipIf(!caps.streaming)("streaming", () => {
      it("streams a command's stdout", async () => {
        const sandbox = await createSandbox();
        target.scriptExec?.("echo streamed", {
          exitCode: 0,
          stdout: "streamed\n",
          stderr: "",
        });
        const chunks: string[] = [];
        await sandbox.streamExec("echo streamed", {
          onStdout: (chunk) => chunks.push(chunk),
        });
        expect(chunks.join("")).toBe("streamed\n");
      });
    });

    describe.skipIf(!caps.listSandboxes)("listing", () => {
      it("lists a sandbox with its org and sizing", async () => {
        const sandbox = await createSandbox();
        const listed = await eventually(async () => {
          const entry = (await provider.sandboxes.list()).find(
            (l) => l.providerSandboxId === sandbox.id,
          );
          expect(entry).toBeDefined();
          return entry!;
        });
        expect(listed.orgId).toBe(ORG_ID);
        expect(listed.state).not.toBe("");
        expect(listed.sizing.vcpus).toBeGreaterThan(0);
        expect(listed.sizing.memoryGib).toBeGreaterThan(0);
      });

      it("no longer lists a deleted sandbox", async () => {
        const sandbox = await createSandbox();
        await sandbox.delete();
        await eventually(async () => {
          const ids = (await provider.sandboxes.list()).map(
            (l) => l.providerSandboxId,
          );
          expect(ids).not.toContain(sandbox.id);
        });
      });
    });

    describe.skipIf(!caps.ssh)("ssh", () => {
      it("mints access that expires later and can be revoked", async () => {
        const sandbox = await createSandbox();
        const before = Date.now();
        const access = await sandbox.ssh!.mint(15);
        expect(access.token).not.toBe("");
        expect(access.sshDestination).not.toBe("");
        expect(access.expiresAt.getTime()).toBeGreaterThan(before);
        await access.revoke();
      });
    });

    describe.skipIf(!caps.services)("services", () => {
      const web: SandboxService = {
        name: "web",
        url: "",
        hostPort: 0,
        containerPort: SERVICE_PORT,
        protocol: "tcp",
      };

      it("returns the requested services from create", async () => {
        const sandbox = await createSandbox({ services: [web] });
        expect(sandbox.created?.services.map((s) => s.name)).toEqual(["web"]);
      });

      it("mints a URL for each service", async () => {
        const sandbox = await createSandbox({ services: [web] });
        const { services } = await sandbox.services!.refreshAll([web]);
        expect(services).toHaveLength(1);
        expect(services[0].name).toBe("web");
        expect(services[0].containerPort).toBe(SERVICE_PORT);
        expect(services[0].url).toMatch(/^https?:\/\//);
        expect(services[0].hostPort).toBeGreaterThan(0);
      });

      it("revokes a service's route", async () => {
        const sandbox = await createSandbox({ services: [web] });
        const loaded = sandbox.services!.load([web]);
        expect(loaded.get(SERVICE_PORT)?.name).toBe("web");
        await loaded.get(SERVICE_PORT)!.revoke();
      });
    });

    describe.skipIf(!caps.snapshots)("snapshots", () => {
      it("reports a missing snapshot as absent", async () => {
        const name = uniqueName("missing");
        expect(await provider.snapshots!.get(name)).toBeNull();
        expect(await provider.snapshots!.find(name)).toBeNull();
      });

      it("creates a sandbox with its scrub-safe marker", async () => {
        const sandbox = await createSandbox({ scrubSafe: true });
        expect(await sandbox.snapshots!.isEnvScrubbable()).toBe(true);
      });

      it.skipIf(!caps.fullSnapshotCapture)(
        "captures a snapshot a new sandbox boots from, keeping the source running",
        async () => {
          const source = await createSandbox();
          const path = `${provider.userHomeDir}/notes.txt`;
          await source.writeFile(path, "kept in snapshot");

          const name = uniqueName("snap");
          const snapshot = trackSnapshot(await source.snapshots!.create(name));
          await snapshot.waitForActive();
          expect(snapshot.name).toBe(name);
          expect(await source.getRuntimeState()).toBe("running");
          expect(await provider.snapshots!.get(name)).not.toBeNull();

          const restored = await createSandbox({}, bootRef(snapshot));
          expect(await restored.readFile(path)).toBe("kept in snapshot");
        },
      );

      it.skipIf(!caps.fullSnapshotCapture)(
        "deletes a snapshot, and deleting it again is a no-op",
        async () => {
          const source = await createSandbox();
          const name = uniqueName("snap");
          const snapshot = trackSnapshot(await source.snapshots!.create(name));
          await snapshot.waitForActive();
          await snapshot.delete();
          await eventually(async () => {
            expect(await provider.snapshots!.get(name)).toBeNull();
          });
          await snapshot.delete();
        },
      );

      it.skipIf(!caps.scrubCapture)(
        "removes the scrub targets before capturing",
        async () => {
          const source = await createSandbox();
          const secret = `${provider.userHomeDir}/.secret-token`;
          const kept = `${provider.userHomeDir}/kept.txt`;
          await source.writeFile(secret, "credential");
          await source.writeFile(kept, "not a secret");

          const name = uniqueName("scrubbed");
          const { snapshot, removedFiles } =
            await source.snapshots!.scrubAndCreate(name, {
              files: [secret],
              sudoFiles: [],
              sudoFileRestores: [],
              envVarNames: [],
            });
          trackSnapshot(snapshot);
          await snapshot.waitForActive();
          expect(removedFiles).toEqual([secret]);

          const restored = await createSandbox({}, bootRef(snapshot));
          expect(await restored.readFile(secret)).toBeNull();
          expect(await restored.readFile(kept)).toBe("not a secret");
        },
      );
    });
  });
}

const noop = () => {};
const silentLogger: Logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  child: () => silentLogger,
};
const ctx: SandboxCtx = { logger: silentLogger, childCtx: () => ctx };

/** Re-run `check` until it stops throwing or `totalMs` has passed. */
async function retryFor<T>(
  totalMs: number,
  check: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
