import { describe, it, expect } from "vitest";
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

const wireService = {
  id: "svc_1",
  sandbox_id: "sbx_1",
  name: "web",
  port: 3000,
  url_scheme: "https",
  protocol: "tcp",
  url: "https://web.example",
  host_port: 3000,
  source: "table",
  kind: "user",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("legacy sandbox method aliases", () => {
  // Each alias forwards to its rig counterpart, so it must issue the same
  // rig-named request. Asserting the URL is what proves the forwarding.
  it("routes rig lifecycle aliases to /rigs", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: [] },
      { status: 202, body: { id: "1", name: "dev" } },
      { status: 200, body: { name: "dev" } },
      { status: 202, body: "" },
      { status: 202, body: "" },
      { status: 204, body: "" },
    ]);
    const client = makeClient(fetch);

    await client.listSandboxes();
    await client.createSandbox({ name: "dev" });
    await client.getSandbox("dev");
    await client.startSandbox("dev");
    await client.stopSandbox("dev");
    await client.deleteSandbox("dev");

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/v0beta1/rigs`,
      `${BASE}/api/v0beta1/rigs`,
      `${BASE}/api/v0beta1/rigs/dev`,
      `${BASE}/api/v0beta1/rigs/dev/start`,
      `${BASE}/api/v0beta1/rigs/dev/stop`,
      `${BASE}/api/v0beta1/rigs/dev`,
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "POST",
      "DELETE",
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ name: "dev" });
  });

  it("routes service aliases to /rig-services and /rigs/{ref}/services", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [] } },
      { status: 201, body: wireService },
      { status: 200, body: wireService },
      { status: 204, body: "" },
    ]);
    const client = makeClient(fetch);
    const req = { name: "web", port: 3000, urlScheme: "https" as const };

    await client.listSandboxServices("dev");
    await client.createSandboxService("dev", req);
    await client.putSandboxService("dev", "web", req);
    await client.deleteSandboxService("dev", "web");

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/v0beta1/rig-services?sandbox_ref=dev`,
      `${BASE}/api/v0beta1/rigs/dev/services`,
      `${BASE}/api/v0beta1/rigs/dev/services/web?by=name`,
      `${BASE}/api/v0beta1/rigs/dev/services/web?by=name`,
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "DELETE",
    ]);
    // The body is the other half of equivalence: a forward that reached the
    // right URL with the wrong payload would pass a URL-only assertion.
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      name: "web",
      port: 3000,
      url_scheme: "https",
    });
  });

  it("listSandboxServices with no ref omits the filter, as listRigServices does", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listSandboxServices();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rig-services`);
  });

  it("listSandboxSnapshots forwards the legacy sourceSandboxId filter", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listSandboxSnapshots({ sourceSandboxId: "sbx-2" });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-snapshots?source_sandbox_id=sbx-2`,
    );
  });

  it("routes snapshot aliases to /rig-snapshots", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [] } },
      { status: 202, body: { snapshot: "my-snap" } },
      { status: 200, body: { snapshot: "my-snap", state: "active" } },
      { status: 200, body: { files: [], env_vars: [] } },
      { status: 204, body: "" },
    ]);
    const client = makeClient(fetch);

    await client.listSandboxSnapshots({ repositoryId: "r_1" });
    await client.createSandboxSnapshot({ sandboxRef: "dev", name: "my-snap" });
    await client.getSandboxSnapshot("my-snap");
    await client.getSandboxScrubPreview("dev");
    await client.deleteSandboxSnapshot("my-snap");

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/v0beta1/rig-snapshots?repository_id=r_1`,
      `${BASE}/api/v0beta1/rig-snapshots`,
      `${BASE}/api/v0beta1/rig-snapshots/my-snap?by=ref`,
      `${BASE}/api/v0beta1/rig-snapshots/scrub-preview?sandbox=dev&by=ref`,
      `${BASE}/api/v0beta1/rig-snapshots/my-snap?by=ref`,
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
      "DELETE",
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      sandbox_ref: "dev",
      name: "my-snap",
    });
  });

  it("waitForSandbox forwards to waitForRig", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { name: "dev", state: "active" } },
    ]);
    const rig = await makeClient(fetch).waitForSandbox("dev");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/dev`);
    expect(rig.state).toBe("active");
  });

  it("waitForSandboxStart and waitForSandboxStop forward to their rig twins", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { name: "dev", state: "running" } },
      { status: 200, body: { name: "dev", state: "stopped" } },
    ]);
    const client = makeClient(fetch);
    expect((await client.waitForSandboxStart("dev")).state).toBe("running");
    expect((await client.waitForSandboxStop("dev")).state).toBe("stopped");
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/v0beta1/rigs/dev`,
      `${BASE}/api/v0beta1/rigs/dev`,
    ]);
  });

  it("waitForSandboxSnapshot forwards to waitForRigSnapshot", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { snapshot: "s", state: "active" } },
    ]);
    const snap = await makeClient(fetch).waitForSandboxSnapshot("s");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rig-snapshots/s?by=ref`);
    expect(snap.state).toBe("active");
  });
});
