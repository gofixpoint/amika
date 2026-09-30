import { describe, it, expect, vi } from "vitest";
import { AmikaClient } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

describe("AmikaClient rig snapshots", () => {
  it("listRigSnapshots GETs /rig-snapshots and unwraps {items} + maps fields", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              snapshot: "amika-mono-base",
              provider: "daytona",
              state: "active",
              source_sandbox_name: "dev",
              base_snapshot: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:05:00Z",
            },
          ],
        },
      },
    ]);
    const client = makeClient(fetch);
    const snapshots = await client.listRigSnapshots();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rig-snapshots`);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.snapshot).toBe("amika-mono-base");
    expect(snapshots[0]?.sourceRigName).toBe("dev");
    expect(snapshots[0]?.sourceSandboxName).toBe("dev");
    expect(snapshots[0]?.baseSnapshot).toBeNull();
  });

  it("listRigSnapshots encodes repository/source filters as query params", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    const client = makeClient(fetch);
    await client.listRigSnapshots({
      repositoryId: "repo-1",
      sourceRigId: "sbx-2",
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots?repository_id=repo-1&source_sandbox_id=sbx-2`,
    );
  });

  it("listRigSnapshots accepts the legacy sourceSandboxId filter", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listRigSnapshots({ sourceSandboxId: "sbx-2" });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots?source_sandbox_id=sbx-2`,
    );
  });

  it("listRigSnapshots sends only the filters that are set", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    const client = makeClient(fetch);
    await client.listRigSnapshots({ repositoryId: "repo-1" });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots?repository_id=repo-1`,
    );
  });

  it("returns an empty list when the envelope has no items", async () => {
    const { fetch } = mockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);
    expect(await client.listRigSnapshots()).toEqual([]);
  });

  it("createRigSnapshot POSTs camelCase → snake_case and parses response", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 202,
        body: { snapshot: "my-snap", provider: "daytona", state: "capturing" },
      },
    ]);
    const client = makeClient(fetch);
    const snap = await client.createRigSnapshot({
      rigRef: "dev",
      name: "my-snap",
      description: "before refactor",
      mode: "full",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rig-snapshots`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      sandbox_ref: "dev",
      name: "my-snap",
      description: "before refactor",
      mode: "full",
    });
    expect(snap.state).toBe("capturing");
  });

  it("createRigSnapshot omits optional fields when not given", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { snapshot: "my-snap" } },
    ]);
    const client = makeClient(fetch);
    await client.createRigSnapshot({ rigRef: "dev", name: "my-snap" });
    expect(Object.keys(JSON.parse(calls[0]?.body ?? ""))).toEqual([
      "sandbox_ref",
      "name",
    ]);
  });

  it("prefers rigRef over sandboxRef when both are set", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { snapshot: "my-snap" } },
    ]);
    await makeClient(fetch).createRigSnapshot({
      rigRef: "from-rig",
      sandboxRef: "from-sandbox",
      name: "my-snap",
    });
    expect(JSON.parse(calls[0]?.body ?? "").sandbox_ref).toBe("from-rig");
  });

  it("falls through to sandboxRef when rigRef is empty", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { snapshot: "my-snap" } },
    ]);
    await makeClient(fetch).createRigSnapshot({
      rigRef: "",
      sandboxRef: "dev",
      name: "my-snap",
    });
    expect(JSON.parse(calls[0]?.body ?? "").sandbox_ref).toBe("dev");
  });

  it("rejects a capture naming no rig, without issuing a request", async () => {
    const { fetch, calls } = mockFetch([]);
    const client = makeClient(fetch);
    // Cast: the union rejects this at compile time, so the throw exists for
    // callers arriving untyped from JavaScript and for an empty string.
    const noRef = { name: "my-snap" } as unknown as Parameters<
      typeof client.createRigSnapshot
    >[0];
    await expect(client.createRigSnapshot(noRef)).rejects.toThrow(
      /rigRef \(or its alias sandboxRef\) is required/,
    );
    await expect(
      client.createRigSnapshot({ rigRef: "", sandboxRef: "", name: "s" }),
    ).rejects.toThrow(/is required/);
    expect(calls).toHaveLength(0);
  });

  it("listRigSnapshots falls through to sourceSandboxId when sourceRigId is empty", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listRigSnapshots({
      sourceRigId: "",
      sourceSandboxId: "sbx-2",
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots?source_sandbox_id=sbx-2`,
    );
  });

  it("listRigSnapshots prefers sourceRigId over the legacy filter", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listRigSnapshots({
      sourceRigId: "from-rig",
      sourceSandboxId: "from-sandbox",
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots?source_sandbox_id=from-rig`,
    );
  });

  it("createRigSnapshot still accepts the legacy sandboxRef field", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { snapshot: "my-snap" } },
    ]);
    await makeClient(fetch).createRigSnapshot({
      sandboxRef: "dev",
      name: "my-snap",
    });
    expect(JSON.parse(calls[0]?.body ?? "").sandbox_ref).toBe("dev");
  });

  it("getRigScrubPreview GETs scrub-preview with sandbox+by params and maps env_vars", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: { files: ["/root/.claude/.credentials.json"], env_vars: ["FOO"] },
      },
    ]);
    const client = makeClient(fetch);
    const preview = await client.getRigScrubPreview("dev");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots/scrub-preview?sandbox=dev&by=ref`,
    );
    expect(preview.files).toEqual(["/root/.claude/.credentials.json"]);
    expect(preview.envVars).toEqual(["FOO"]);
  });

  it("getRigScrubPreview URL-encodes the rig ref", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { files: [], env_vars: [] } },
    ]);
    const client = makeClient(fetch);
    await client.getRigScrubPreview("org/dev");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots/scrub-preview?sandbox=org%2Fdev&by=ref`,
    );
  });

  it("deleteRigSnapshot DELETEs by ref, URL-encoding the reference", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.deleteRigSnapshot("org/my-snap");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots/org%2Fmy-snap?by=ref`,
    );
  });
});

describe("AmikaClient snapshot fetch and wait", () => {
  it("getRigSnapshot resolves by ref and decodes every field", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          id: "snap_1",
          snapshot: "proj-base",
          provider: "daytona",
          description: null,
          source_sandbox_id: "sbx_1",
          source_sandbox_name: "dev",
          repository_id: "r_1",
          repository_url: "git@github.com:o/p.git",
          base_snapshot: null,
          sandbox_preset: "coder",
          sandbox_size: null,
          capture_mode: "scrub_and_delete",
          state: "active",
          error_message: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:01:00Z",
          daytona: { name: "amika-proj-base", state: "active", cpu: 2 },
        },
      },
    ]);
    const snap = await makeClient(fetch).getRigSnapshot("org/proj-base");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots/org%2Fproj-base?by=ref`,
    );
    expect(snap.id).toBe("snap_1");
    expect(snap.sourceRigId).toBe("sbx_1");
    expect(snap.sourceSandboxId).toBe("sbx_1");
    expect(snap.rigPreset).toBe("coder");
    expect(snap.sandboxPreset).toBe("coder");
    expect(snap.rigSize).toBeNull();
    expect(snap.sandboxSize).toBeNull();
    expect(snap.repositoryUrl).toBe("git@github.com:o/p.git");
    expect(snap.captureMode).toBe("scrub_and_delete");
    expect(snap.daytona).toEqual({
      name: "amika-proj-base",
      state: "active",
      imageName: undefined,
      cpu: 2,
      memory: undefined,
      disk: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
  });

  it("leaves daytona null when the provider sends none", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { snapshot: "s", state: "active" } },
    ]);
    const snap = await makeClient(fetch).getRigSnapshot("s");
    expect(snap.daytona).toBeNull();
  });

  it("getRigScrubPreview decodes restored_files", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          files: ["/home/amika/.claude/.credentials.json"],
          restored_files: ["/home/amika/.gitconfig"],
          env_vars: ["ANTHROPIC_API_KEY"],
        },
      },
    ]);
    const preview = await makeClient(fetch).getRigScrubPreview("dev");
    expect(preview.restoredFiles).toEqual(["/home/amika/.gitconfig"]);
  });

  it("waitForRigSnapshot polls every 3 seconds until active", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { snapshot: "s", state: "capturing" } },
        { status: 200, body: { snapshot: "s", state: "capturing" } },
        { status: 200, body: { snapshot: "s", state: "active" } },
      ]);
      const promise = makeClient(fetch).waitForRigSnapshot("s");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await promise).state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitForRigSnapshot throws the server's message on failure", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: { snapshot: "s", state: "failed", error_message: "disk full" },
      },
    ]);
    await expect(makeClient(fetch).waitForRigSnapshot("s")).rejects.toThrow(
      /disk full/,
    );
  });

  // These strings are user-facing and changed from 0.11 ("sandbox ... failed")
  // when the SDK moved to rig terminology. Pin them so a later edit cannot move
  // them again silently.
  it("throws rig-worded fallbacks when the server gives no errorMessage", async () => {
    const failed = { status: 200, body: { name: "dev", state: "failed" } };
    const { fetch } = mockFetch([failed, failed, failed]);
    const client = makeClient(fetch);
    await expect(client.waitForRig("dev")).rejects.toThrow(
      /^rig provisioning failed$/,
    );
    await expect(client.waitForRigStart("dev")).rejects.toThrow(
      /^rig start failed$/,
    );
    await expect(client.waitForRigStop("dev")).rejects.toThrow(
      /^rig stop failed$/,
    );
  });

  it("waitForRigSnapshot falls back to a generic message", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { snapshot: "s", state: "failed" } },
    ]);
    await expect(makeClient(fetch).waitForRigSnapshot("s")).rejects.toThrow(
      /rig snapshot capture failed/,
    );
  });
});
