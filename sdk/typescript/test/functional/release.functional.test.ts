/**
 * Release test suite for the TypeScript SDK against staging.
 *
 * Mirrors the CLI test cases in devdocs/release-testplan.md:
 *   - Create a sandbox with the example repo
 *   - Snapshot round-trip: write sentinel, capture, boot from snapshot, verify sentinel
 *   - Scrub-and-delete: capture deletes the source sandbox on completion
 *
 * Required env vars:
 *   AMIKA_API_URL   — e.g. https://app.staging-amika.dev
 *   AMIKA_API_TOKEN — staging API key
 *
 * Optional:
 *   AMIKA_TEST_SANDBOX_PROVIDER — default "daytona" (remote)
 */

import { spawnSync } from "child_process";
import { afterAll, beforeAll, expect, it } from "vitest";

import { AmikaClient } from "@/client";
import type { RemoteSandbox } from "@/types";

import {
  LONG_TIMEOUT_MS,
  describeFunctional,
  makeClient,
  uniqueSandboxName,
} from "./helpers";

const PROVIDER = process.env["AMIKA_TEST_SANDBOX_PROVIDER"] ?? "daytona";
const EXAMPLE_REPO = "https://github.com/gofixpoint/example-repo";
const SENTINEL_PATH = "/home/amika/snapshot-check.txt";
const SENTINEL_VALUE = "hello-snapshot";

/**
 * Run a command inside a sandbox via SSH, return trimmed stdout.
 * Retries on exit 255 (transport-level failure: SSH daemon not yet ready)
 * with exponential backoff.
 */
function sshRun(
  sshDestination: string,
  command: string,
  { maxAttempts = 6, baseDelayMs = 5_000 } = {},
): string {
  const args = sshDestination.trim().split(/\s+/);
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
    const result = spawnSync(
      "ssh",
      [...args, "-o", "StrictHostKeyChecking=accept-new", "--", command],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout.trim();
    // SSH exit 255 = transport failure (connection refused / not yet ready).
    // Any other non-zero exit = command error inside the sandbox, don't retry.
    if (result.status !== 255) {
      throw new Error(
        `SSH command failed (exit ${result.status}): ${result.stderr}`,
      );
    }
    lastErr = new Error(
      `SSH connection failed (exit 255, attempt ${attempt + 1}/${maxAttempts})`,
    );
  }
  throw lastErr;
}

/** Poll until a snapshot slug reaches the target state. */
async function waitForSnapshot(
  client: AmikaClient,
  slug: string,
  targetState = "active",
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshots = await client.listSandboxSnapshots();
    const snap = snapshots.find((s) => s.snapshot === slug);
    if (snap?.state === targetState) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(
    `Snapshot "${slug}" did not reach "${targetState}" within ${timeoutMs}ms`,
  );
}

/** Poll sandbox list until the named sandbox is absent. */
async function waitForSandboxGone(
  client: AmikaClient,
  name: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sandboxes = await client.listSandboxes();
    if (!sandboxes.some((s) => s.name === name)) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Sandbox "${name}" was not deleted within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test 1: Create a sandbox with the example repo
// ---------------------------------------------------------------------------

describeFunctional("Release test: create sandbox with example repo", () => {
  let client: AmikaClient;
  let sandbox: RemoteSandbox;
  const sandboxName = uniqueSandboxName("dylan-rls");

  beforeAll(async () => {
    client = makeClient();
    const created = await client.createSandbox({
      name: sandboxName,
      provider: PROVIDER,
      repoUrl: EXAMPLE_REPO,
      preset: "coder",
    });
    afterAll(async () => {
      try {
        await client.deleteSandbox(created.name);
      } catch {
        // Already deleted, or the server is unreachable; ignore.
      }
    });
    sandbox = await client.waitForSandbox(created.name);
  }, LONG_TIMEOUT_MS);

  it("sandbox reaches started state", () => {
    expect(sandbox.state).toBe("started");
  });

  it("repo URL contains example-repo", () => {
    expect(sandbox.repoUrl).toContain("example-repo");
  });

  it("provider is daytona", () => {
    expect(sandbox.provider).toBe("daytona");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Snapshot round-trip preserves sandbox contents
// ---------------------------------------------------------------------------

describeFunctional("Release test: snapshot round-trip", () => {
  let client: AmikaClient;
  let sourceSandbox: RemoteSandbox;
  let snapshotSlug: string;
  let fromSnapSandbox: RemoteSandbox;

  const sourceName = uniqueSandboxName("dylan-snap-src");
  const snapName = uniqueSandboxName("dylan-roundtrip");
  const fromSnapName = uniqueSandboxName("dylan-from-snap");

  beforeAll(async () => {
    client = makeClient();

    // Create and wait for source sandbox
    const created = await client.createSandbox({
      name: sourceName,
      provider: PROVIDER,
      repoUrl: EXAMPLE_REPO,
      preset: "coder",
    });
    afterAll(async () => {
      try {
        await client.deleteSandbox(sourceName);
      } catch {
        // Already deleted, or the server is unreachable; ignore.
      }
    });
    sourceSandbox = await client.waitForSandbox(created.name);
  }, LONG_TIMEOUT_MS);

  it("source sandbox reaches started state with daytona provider", () => {
    expect(sourceSandbox.state).toBe("started");
    expect(sourceSandbox.provider).toBe("daytona");
  });

  it(
    "write and read sentinel file via SSH",
    async () => {
      const info = await client.getSSH(sourceSandbox.name);
      sshRun(info.sshDestination, `echo ${SENTINEL_VALUE} > ${SENTINEL_PATH}`);
      const content = sshRun(info.sshDestination, `cat ${SENTINEL_PATH}`);
      expect(content).toBe(SENTINEL_VALUE);
    },
    LONG_TIMEOUT_MS,
  );

  it(
    "create full snapshot and poll to active; source sandbox still present",
    async () => {
      const snap = await client.createSandboxSnapshot({
        sandboxRef: sourceSandbox.name,
        name: snapName,
        mode: "full",
      });

      // Store slug for downstream tests
      snapshotSlug = snap.snapshot;
      expect(snapshotSlug).not.toBe("");

      await waitForSnapshot(client, snapshotSlug, "active");

      // Source sandbox must still be running
      const sandboxes = await client.listSandboxes();
      const src = sandboxes.find((s) => s.name === sourceSandbox.name);
      expect(src?.state).toBe("started");
    },
    LONG_TIMEOUT_MS,
  );

  it(
    "boot new sandbox from snapshot and verify sentinel survived",
    async () => {
      const created = await client.createSandbox({
        name: fromSnapName,
        provider: PROVIDER,
        preset: "coder",
        snapshot: snapshotSlug,
      });
      afterAll(async () => {
        try {
          await client.deleteSandbox(fromSnapName);
        } catch {
          // Already deleted, or the server is unreachable; ignore.
        }
      });

      fromSnapSandbox = await client.waitForSandbox(created.name);
      expect(fromSnapSandbox.state).toBe("started");

      const info = await client.getSSH(fromSnapSandbox.name);
      const content = sshRun(info.sshDestination, `cat ${SENTINEL_PATH}`);
      expect(content).toBe(SENTINEL_VALUE);
    },
    LONG_TIMEOUT_MS,
  );

  afterAll(async () => {
    if (snapshotSlug) {
      try {
        await client.deleteSandboxSnapshot(snapshotSlug);
      } catch {
        // Already deleted, or the server is unreachable; ignore.
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Scrub-and-delete snapshot removes the source sandbox
// ---------------------------------------------------------------------------

describeFunctional("Release test: scrub-and-delete snapshot", () => {
  let client: AmikaClient;
  let sourceSandbox: RemoteSandbox;
  let snapshotSlug: string;

  const sourceName = uniqueSandboxName("dylan-scrub-src");
  const snapName = uniqueSandboxName("dylan-scrub-rt");

  beforeAll(async () => {
    client = makeClient();

    const created = await client.createSandbox({
      name: sourceName,
      provider: PROVIDER,
      repoUrl: EXAMPLE_REPO,
      preset: "coder",
    });
    sourceSandbox = await client.waitForSandbox(created.name);
  }, LONG_TIMEOUT_MS);

  it("source sandbox reaches started state", () => {
    expect(sourceSandbox.state).toBe("started");
  });

  it(
    "scrub-and-delete snapshot captures and deletes source on completion",
    async () => {
      const snap = await client.createSandboxSnapshot({
        sandboxRef: sourceSandbox.name,
        name: snapName,
        mode: "scrub_and_delete",
      });
      snapshotSlug = snap.snapshot;

      // Source sandbox should transition to "snapshotting" immediately
      const sandboxes = await client.listSandboxes();
      const src = sandboxes.find((s) => s.name === sourceSandbox.name);
      expect(["snapshotting", "started"]).toContain(src?.state);

      // Wait for snapshot to go active
      await waitForSnapshot(client, snapshotSlug, "active");

      // Source sandbox must be gone
      await waitForSandboxGone(client, sourceSandbox.name);
      const after = await client.listSandboxes();
      expect(after.some((s) => s.name === sourceSandbox.name)).toBe(false);
    },
    LONG_TIMEOUT_MS,
  );

  afterAll(async () => {
    if (snapshotSlug) {
      try {
        await client.deleteSandboxSnapshot(snapshotSlug);
      } catch {
        // Already deleted, or the server is unreachable; ignore.
      }
    }
    // Belt-and-suspenders: delete source sandbox in case scrub-and-delete
    // did not fire (e.g. the test was interrupted mid-run).
    try {
      await client.deleteSandbox(sourceSandbox.name);
    } catch {
      // Already deleted, or the server is unreachable; ignore.
    }
  });
});
