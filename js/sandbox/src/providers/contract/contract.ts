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
 *
 * What the suite assumes about a sandbox booted from `bootSnapshot`. These
 * are requirements on the test fixture, not on every sandbox a provider boots:
 *   - commands run in a POSIX shell with `echo`, `printf`, `pwd`, `sleep`,
 *     and `exit`;
 *   - `/tmp` exists;
 *   - `$HOME` is `provider.userHomeDir`, and the user can write files there;
 *   - service URLs are `http://` or `https://`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fileSink, Ledger } from "./ledger";
import {
  trackSandbox,
  trackSnapshot as trackSnapshotIn,
  trackSshAccess,
  type TrackingContext,
} from "./tracking";
import { newRunId } from "./run-dir";
import type { Logger, SandboxCtx } from "../../logger";
import type { SandboxService } from "../../types";
import { SANDBOX_PROVIDER_CAPABILITIES } from "../capabilities";
import type { SandboxAdapter } from "../shared/adapter";
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
   * Return an adapter for an existing sandbox. Setup code uses this adapter
   * to run commands and read or write files. This does not create a sandbox
   * or run setup. Omit this when the provider has no adapter.
   */
  openAdapter?(providerSandboxId: string): Promise<SandboxAdapter>;
  /**
   * How long to keep polling for a change the vendor applies asynchronously,
   * such as a deleted sandbox leaving the account listing. Default 0: check
   * once.
   */
  settleMs?: number;
  /**
   * Append every resource the suite creates, and its deletion outcome, to
   * this JSON-lines file (see `./ledger.ts`). Unset keeps the ledger in
   * memory only.
   */
  auditFile?: string;
  /**
   * The account and endpoint the provider points at (`targetIdentity`),
   * written as the ledger's first line so the sweep can refuse to act on a
   * different target.
   */
  identity?: Record<string, string>;
}

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
  const runId = newRunId();
  let sequence = 0;
  const uniqueName = (kind: string) =>
    `contract-${kind}-${runId}-${(sequence += 1)}`;

  // Every resource a test creates is recorded here the moment it exists and
  // deleted, newest first, after the test. The outcome of each delete is
  // recorded too, so the file is a full audit of what the run touched.
  const ledger = new Ledger(
    provider.name,
    target.auditFile ? fileSink(target.auditFile) : () => {},
  );
  if (target.identity) ledger.begin(target.identity);
  afterEach(() => ledger.release());
  const currentTest = () => expect.getState().currentTestName ?? "unknown";

  async function createSandbox(
    overrides: { services?: SandboxService[]; scrubSafe?: boolean } = {},
    snapshot: string = target.bootSnapshot,
  ): Promise<Sandbox> {
    const name = uniqueName("sb");
    const identify = trackSandbox(tracking, name);
    return identify(
      await provider.sandboxes.create(ctx, {
        name,
        snapshot,
        services: overrides.services ?? [],
        scrubSafe: overrides.scrubSafe,
      }),
    );
  }

  /** The value `create` accepts to boot from `snapshot`. */
  function bootRef(snapshot: Snapshot): string {
    if (!caps.snapshotIdsAreOpaque) return snapshot.name;
    expect(snapshot.providerSnapshotId).toBeTruthy();
    return snapshot.providerSnapshotId!;
  }

  const eventually = <T>(check: () => Promise<T>) =>
    retryFor(target.settleMs ?? 0, check);

  /** Poll `check` for the settle window; `false` if it never reported gone. */
  const isGone = (check: () => Promise<boolean>) =>
    eventually(async () => {
      if (!(await check())) throw new Error("still present");
      return true;
    }).catch(() => false);

  const tracking: TrackingContext = {
    ledger,
    provider,
    snapshotIds,
    currentTest,
    isGone: (check) => isGone(check),
  };
  /** See `trackSnapshot` in `./tracking.ts`. */
  const trackSnapshot = (name: string) => trackSnapshotIn(tracking, name);

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

    describe.skipIf(!caps.exec)("exec", () => {
      it.each(EXEC_CASES)("$name", async ({ command, opts, want }) => {
        const sandbox = await createSandbox();
        expect(await sandbox.exec(command, opts)).toEqual(want);
      });

      it("runs commands as the user whose home is userHomeDir", async () => {
        const sandbox = await createSandbox();
        expect(await sandbox.exec("printf '%s\\n' \"$HOME\"")).toEqual({
          exitCode: 0,
          stdout: `${provider.userHomeDir}\n`,
          stderr: "",
        });
      });
    });

    describe.skipIf(!caps.lifecycle)("lifecycle", () => {
      it("is running after create", async () => {
        const sandbox = await createSandbox();
        expect(await sandbox.getRuntimeState()).toBe("running");
      });

      it("stops and starts again", async () => {
        const sandbox = await createSandbox();
        await sandbox.stop();
        expect(await sandbox.getRuntimeState()).toBe("stopped");
        await sandbox.start();
        expect(await sandbox.getRuntimeState()).toBe("running");
        expect(await sandbox.exec("echo back")).toEqual({
          exitCode: 0,
          stdout: "back\n",
          stderr: "",
        });
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

    describe.skipIf(!caps.lifecycle || !target.openAdapter)(
      "provisioning adapter",
      () => {
        it("runs a command", async () => {
          const sandbox = await createSandbox();
          const adapter = await target.openAdapter!(sandbox.id);
          expect(await adapter.exec("echo via adapter")).toEqual({
            exitCode: 0,
            stdout: "via adapter\n",
            stderr: "",
          });
        });

        it("uploads a file the sandbox can read, and downloads it back", async () => {
          const sandbox = await createSandbox();
          const adapter = await target.openAdapter!(sandbox.id);
          const path = `${provider.userHomeDir}/uploaded.txt`;
          await adapter.uploadFile("uploaded", path);
          expect(await sandbox.readFile(path)).toBe("uploaded");
          expect(await adapter.downloadFile(path)).toBe("uploaded");
        });

        it("downloads a missing file as null", async () => {
          const sandbox = await createSandbox();
          const adapter = await target.openAdapter!(sandbox.id);
          expect(
            await adapter.downloadFile(`${provider.userHomeDir}/missing.txt`),
          ).toBeNull();
        });
      },
    );

    describe.skipIf(!caps.streaming)("streaming", () => {
      it("streams stdout and stderr to their own handlers", async () => {
        const sandbox = await createSandbox();
        const stdout: string[] = [];
        const stderr: string[] = [];
        await sandbox.streamExec("echo out; echo err 1>&2", {
          onStdout: (chunk) => stdout.push(chunk),
          onStderr: (chunk) => stderr.push(chunk),
        });
        expect(stdout.join("")).toBe("out\n");
        expect(stderr.join("")).toBe("err\n");
      });

      it("delivers output while the command is still running", async () => {
        const sandbox = await createSandbox();
        const chunks: string[] = [];
        let firstChunkAt = 0;
        await sandbox.streamExec("echo first; sleep 2; echo second", {
          onStdout: (chunk) => {
            firstChunkAt ||= Date.now();
            chunks.push(chunk);
          },
        });
        const finishedAt = Date.now();
        expect(chunks.join("")).toBe("first\nsecond\n");
        // "first" must arrive during `sleep 2`, not when the command ends.
        expect(finishedAt - firstChunkAt).toBeGreaterThanOrEqual(1_000);
      });
    });

    describe.skipIf(!caps.listSandboxes)("listing", () => {
      it("lists a sandbox with its state and sizing", async () => {
        const sandbox = await createSandbox();
        const listed = await eventually(async () => {
          const entry = (await provider.sandboxes.list()).find(
            (l) => l.providerSandboxId === sandbox.id,
          );
          expect(entry).toBeDefined();
          return entry!;
        });
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
        // Recorded before any assertion, so it is revoked even if one fails.
        const access = trackSshAccess(
          tracking,
          sandbox.id,
          await sandbox.ssh!.mint(15),
        );
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
          const identify = trackSnapshot(name);
          const snapshot = identify(await source.snapshots!.create(name));
          await snapshot.waitForActive();
          expect(snapshot.name).toBe(name);
          expect(await source.getRuntimeState()).toBe("running");
          expect(await provider.snapshots!.get(name)).not.toBeNull();
          expect(await provider.snapshots!.find(name)).not.toBeNull();

          const restored = await createSandbox({}, bootRef(snapshot));
          expect(await restored.readFile(path)).toBe("kept in snapshot");
        },
      );

      it.skipIf(!caps.fullSnapshotCapture)(
        "deletes a snapshot, and deleting it again is a no-op",
        async () => {
          const source = await createSandbox();
          const name = uniqueName("snap");
          const identify = trackSnapshot(name);
          const snapshot = identify(await source.snapshots!.create(name));
          await snapshot.waitForActive();
          await snapshot.delete();
          await eventually(async () => {
            expect(await provider.snapshots!.find(name)).toBeNull();
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
          const identify = trackSnapshot(name);
          const { snapshot, removedFiles } =
            await source.snapshots!.scrubAndCreate(name, {
              files: [secret],
              sudoFiles: [],
              sudoFileRestores: [],
              envVarNames: [],
            });
          identify(snapshot);
          await snapshot.waitForActive();
          expect(removedFiles).toEqual([secret]);
          // Looked up by name, as a caller does. On a provider with opaque
          // ids this goes through the recorded name -> id mapping.
          expect(await provider.snapshots!.get(name)).not.toBeNull();
          expect(await provider.snapshots!.find(name)).not.toBeNull();

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
