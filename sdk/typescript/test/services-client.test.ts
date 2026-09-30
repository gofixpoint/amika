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

describe("AmikaClient rig services", () => {
  it("listRigServices unwraps {items} and filters by sandbox_ref", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [wireService] } },
    ]);
    const services = await makeClient(fetch).listRigServices("org/dev");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rig-services?sandbox_ref=org%2Fdev`,
    );
    expect(services[0]?.urlScheme).toBe("https");
    expect(services[0]?.hostPort).toBe(3000);
    expect(services[0]?.rigId).toBe("sbx_1");
    expect(services[0]?.sandboxId).toBe("sbx_1");
  });

  it("listRigServices omits the filter when no ref is given", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listRigServices();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rig-services`);
  });

  it("keeps a legacy service's null url and id", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              ...wireService,
              id: null,
              url: null,
              url_scheme: null,
              host_port: null,
            },
          ],
        },
      },
    ]);
    const services = await makeClient(fetch).listRigServices();
    expect(services[0]?.id).toBeNull();
    expect(services[0]?.url).toBeNull();
    expect(services[0]?.urlScheme).toBeNull();
    expect(services[0]?.hostPort).toBeNull();
  });

  it("createRigService POSTs url_scheme in snake_case", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: wireService }]);
    const svc = await makeClient(fetch).createRigService("org/dev", {
      name: "web",
      port: 3000,
      urlScheme: "https",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/org%2Fdev/services`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "web",
      port: 3000,
      url_scheme: "https",
    });
    expect(svc.name).toBe("web");
  });

  it("putRigService resolves by name unless told otherwise", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: wireService },
      { status: 200, body: wireService },
    ]);
    const client = makeClient(fetch);
    const req = { name: "web", port: 3001, urlScheme: "http" as const };
    await client.putRigService("dev", "web", req);
    await client.putRigService("dev", "svc_1", req, "id");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rigs/dev/services/web?by=name`,
    );
    expect(calls[1]?.url).toBe(
      `${BASE}/api/v0beta1/rigs/dev/services/svc_1?by=id`,
    );
  });

  it("deleteRigService DELETEs by name", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    await makeClient(fetch).deleteRigService("dev", "web");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/rigs/dev/services/web?by=name`,
    );
  });
});

describe("rig service port validation", () => {
  // Mirrors go/internal/services.TestValidatePort so the two stay in step.
  it.each([3000, 1, 65535, 60898, 61000])("accepts port %i", async (port) => {
    const { fetch, calls } = mockFetch([{ status: 201, body: {} }]);
    await makeClient(fetch).createRigService("dev", {
      name: "web",
      port,
      urlScheme: "http",
    });
    expect(JSON.parse(calls[0]?.body ?? "").port).toBe(port);
  });

  it.each([
    [0, /must be between 1 and 65535/],
    [-1, /must be between 1 and 65535/],
    [70000, /must be between 1 and 65535/],
    [3000.5, /must be between 1 and 65535/],
    [60899, /reserved for internal Amika services/],
    [60999, /reserved for internal Amika services/],
    [60950, /reserved for internal Amika services/],
  ])("rejects port %i without issuing a request", async (port, message) => {
    const { fetch, calls } = mockFetch([]);
    const client = makeClient(fetch);
    const req = { name: "web", port, urlScheme: "http" as const };
    await expect(client.createRigService("dev", req)).rejects.toThrow(message);
    await expect(client.putRigService("dev", "web", req)).rejects.toThrow(
      message,
    );
    expect(calls).toHaveLength(0);
  });
});
