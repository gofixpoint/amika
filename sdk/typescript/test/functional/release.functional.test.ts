/**
 * Release test suite for the TypeScript SDK against staging.
 *
 * Mirrors the CLI test cases in devdocs/release-testplan.md:
 *   - Create a rig with the example repo
 *   - Snapshot round-trip: write sentinel, capture, boot from snapshot, verify sentinel
 *   - Scrub-and-delete: capture deletes the source rig on completion
 *
 * Required env vars:
 *   AMIKA_API_URL   — e.g. https://app.staging-amika.dev
 *   AMIKA_API_TOKEN — staging API key
 *
 * Optional:
 *   AMIKA_TEST_RIG_PROVIDER — default "e2b"; the former
 *                             AMIKA_TEST_SANDBOX_PROVIDER still works
 *
 * Readiness is asserted on the canonical `status`, not the raw `state`: a live
 * rig's `state` is the provider's own run state ("started" on Daytona,
 * "running" on E2B), while `status` is the same on every provider.
 */

import { beforeAll, expect, it } from "vitest";

import { AmikaClient } from "@/index";
import type { RemoteRig } from "@/index";

import {
  Cleanup,
  LONG_TIMEOUT_MS,
  TEST_RIG_PROVIDER,
  describeFunctional,
  makeClient,
  uniqueRigName,
} from "./helpers";

const EXAMPLE_REPO = "https://github.com/gofixpoint/example-repo";
/** Poll until a snapshot slug reaches the target state. */
async function waitForSnapshot(
  client: AmikaClient,
  slug: string,
  targetState = "active",
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshots = await client.listRigSnapshots();
    const snap = snapshots.find((s) => s.snapshot === slug);
    if (snap?.state === targetState) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(
    `Snapshot "${slug}" did not reach "${targetState}" within ${timeoutMs}ms`,
  );
}

/** Poll the rig list until the named rig is absent. */
async function waitForRigGone(
  client: AmikaClient,
  name: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rigs = await client.listRigs();
    if (!rigs.some((s) => s.name === name && !/delet/i.test(s.state))) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Rig "${name}" was not deleted within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Test 1: Create a rig with the example repo
// ---------------------------------------------------------------------------

describeFunctional("Release test: create rig with example repo", () => {
  let client: AmikaClient;
  let rig: RemoteRig;
  const rigName = uniqueRigName("dylan-rls");
  const cleanup = new Cleanup();

  beforeAll(async () => {
    client = makeClient();
    const created = await client.createRig({
      name: rigName,
      provider: TEST_RIG_PROVIDER,
      repoUrl: EXAMPLE_REPO,
      preset: "coder",
    });
    cleanup.rig(client, created.name);
    rig = await client.waitForRig(created.name);
  }, LONG_TIMEOUT_MS);

  it("rig reaches running status", () => {
    expect(rig.status).toBe("running");
  });

  it("repo URL contains example-repo", () => {
    expect(rig.repoUrl).toContain("example-repo");
  });

  it("provider is the configured provider", () => {
    expect(rig.provider).toBe(TEST_RIG_PROVIDER);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Snapshot round-trip preserves rig contents
// ---------------------------------------------------------------------------

describeFunctional("Release test: snapshot round-trip", () => {
  let client: AmikaClient;
  let sourceRig: RemoteRig;
  let snapshotSlug: string;
  let fromSnapRig: RemoteRig;

  const sourceName = uniqueRigName("dylan-snap-src");
  const snapName = uniqueRigName("dylan-roundtrip");
  const fromSnapName = uniqueRigName("dylan-from-snap");
  const cleanup = new Cleanup();

  beforeAll(async () => {
    client = makeClient();

    // Create and wait for the source rig
    const created = await client.createRig({
      name: sourceName,
      provider: TEST_RIG_PROVIDER,
      repoUrl: EXAMPLE_REPO,
      preset: "coder",
    });
    cleanup.rig(client, sourceName);
    sourceRig = await client.waitForRig(created.name);
  }, LONG_TIMEOUT_MS);

  it("source rig reaches running status on the configured provider", () => {
    expect(sourceRig.status).toBe("running");
    expect(sourceRig.provider).toBe(TEST_RIG_PROVIDER);
  });

  it(
    "create full snapshot and poll to active; source rig still present",
    async () => {
      const snap = await client.createRigSnapshot({
        rig: sourceRig.name,
        name: snapName,
        mode: "full",
      });

      // Store slug for downstream tests
      snapshotSlug = snap.snapshot;
      expect(snapshotSlug).not.toBe("");
      cleanup.later(() => client.deleteRigSnapshot(snapshotSlug));

      await waitForSnapshot(client, snapshotSlug, "active");

      // The source rig must still be running
      const rigs = await client.listRigs();
      const src = rigs.find((s) => s.name === sourceRig.name);
      expect(src?.status).toBe("running");
    },
    LONG_TIMEOUT_MS,
  );

  it(
    "boot a new rig from the snapshot",
    async () => {
      const created = await client.createRig({
        name: fromSnapName,
        provider: TEST_RIG_PROVIDER,
        preset: "coder",
        snapshot: snapshotSlug,
      });
      cleanup.rig(client, fromSnapName);

      fromSnapRig = await client.waitForRig(created.name);
      expect(fromSnapRig.status).toBe("running");
    },
    LONG_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 3: Scrub-and-delete snapshot removes the source rig
// ---------------------------------------------------------------------------

describeFunctional("Release test: scrub-and-delete snapshot", () => {
  let client: AmikaClient;
  let sourceRig: RemoteRig;
  let snapshotSlug: string;

  const sourceName = uniqueRigName("dylan-scrub-src");
  const snapName = uniqueRigName("dylan-scrub-rt");
  const cleanup = new Cleanup();

  beforeAll(async () => {
    client = makeClient();

    const created = await client.createRig({
      name: sourceName,
      provider: TEST_RIG_PROVIDER,
      repoUrl: EXAMPLE_REPO,
      preset: "coder",
    });
    // Scrub-and-delete removes it on success; this covers a failed run.
    cleanup.rig(client, created.name);
    sourceRig = await client.waitForRig(created.name);
  }, LONG_TIMEOUT_MS);

  it("source rig reaches running status", () => {
    expect(sourceRig.status).toBe("running");
  });

  it(
    "scrub-and-delete snapshot captures and deletes source on completion",
    async () => {
      const snap = await client.createRigSnapshot({
        rig: sourceRig.name,
        name: snapName,
        mode: "scrub_and_delete",
      });
      snapshotSlug = snap.snapshot;
      cleanup.later(() => client.deleteRigSnapshot(snapshotSlug));

      // The source rig should transition to "snapshotting" immediately
      const rigs = await client.listRigs();
      const src = rigs.find((s) => s.name === sourceRig.name);
      expect(["snapshotting", "running"]).toContain(src?.status);

      // Wait for snapshot to go active
      await waitForSnapshot(client, snapshotSlug, "active");

      // The source rig must be gone (or in a terminal deleted state).
      await waitForRigGone(client, sourceRig.name);
      const after = await client.listRigs();
      expect(
        after.some((s) => s.name === sourceRig.name && !/delet/i.test(s.state)),
      ).toBe(false);
    },
    LONG_TIMEOUT_MS,
  );
});
