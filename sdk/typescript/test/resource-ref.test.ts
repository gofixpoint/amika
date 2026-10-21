import { describe, expect, it } from "vitest";
import { AmikaClient, type RefKind, type RigRef } from "@/index";
import { mockFetch } from "./helpers.js";

// Every method that identifies a rig (or a snapshot) accepts a ResourceRef: a
// plain string is a ref (ID or name), and the object form pins the kind. These
// tests pin the exact wire output for each form, each deprecated alias, and
// the validation that runs before any request.

const BASE = "https://api.example.com";
const API = `${BASE}/api/v0beta1`;

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

/** Each accepted form for the value "dev/1", with the kind it pins (if any). */
const FORMS: [label: string, ref: RigRef, pinned: RefKind | undefined][] = [
  ["a plain string", "dev/1", undefined],
  ['{ by: "name" }', { ref: "dev/1", by: "name" }, "name"],
  ['{ by: "id" }', { ref: "dev/1", by: "id" }, "id"],
  ['{ by: "ref" }', { ref: "dev/1", by: "ref" }, "ref"],
];

/** The kind a form resolves to on the wire. A plain string is a ref. */
const kindOf = (pinned: RefKind | undefined): RefKind => pinned ?? "ref";

/** References that must be rejected before any request, with the message. */
const INVALID: [label: string, ref: unknown, message: string][] = [
  ["an empty string", "", "rig must not be empty"],
  ["a whitespace string", " \t", "rig must not be empty"],
  ["an empty object ref", { ref: "", by: "id" }, "rig must not be empty"],
  [
    "an unknown kind",
    { ref: "dev", by: "slug" },
    'rig.by must be one of "id", "name", or "ref"',
  ],
  ["a missing kind", { ref: "dev" }, "rig.by must be one of"],
  ["a non-string ref", { ref: 7, by: "id" }, "rig.ref must be a string"],
  ["a number", 7, "rig must be a string or an object"],
];

const wireRig = {
  id: "rig/9",
  name: "dev",
  state: "active",
  status: "running",
  setup_status: "ok",
};
const wireService = {
  id: "svc_1",
  sandbox_id: "rig/9",
  name: "web",
  port: 3000,
  url_scheme: "https",
};
const wireSnapshot = { id: "snap/9", snapshot: "base", state: "active" };
const wireTurn = { session_id: "chat1", sandbox_id: "rig/9", response: "ok" };
const serviceReq = { name: "web", port: 3000, urlScheme: "https" as const };

describe("rigs: the rig is the path's primary resource (by)", () => {
  it.each(FORMS)("get with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: wireRig }]);
    await makeClient(fetch).rigs.get(ref);
    // A plain string omits `by`: the server's default is already ref.
    expect(calls[0]?.url).toBe(
      `${API}/rigs/dev%2F1${pinned ? `?by=${pinned}` : ""}`,
    );
  });

  it.each(FORMS)("getAndWait with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: wireRig }]);
    await makeClient(fetch).rigs.getAndWait(ref);
    expect(calls[0]?.url).toBe(
      `${API}/rigs/dev%2F1${pinned ? `?by=${pinned}` : ""}`,
    );
  });

  it.each(FORMS)(
    "an unfetched handle's start, stop, and delete with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { status: 204 },
        { status: 204 },
        { status: 204 },
      ]);
      const handle = makeClient(fetch).rigs.handle(ref);
      await handle.start();
      await handle.stop();
      await handle.delete();
      const qs = pinned ? `?by=${pinned}` : "";
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["POST", `${API}/rigs/dev%2F1/start${qs}`],
        ["POST", `${API}/rigs/dev%2F1/stop${qs}`],
        ["DELETE", `${API}/rigs/dev%2F1${qs}`],
      ]);
    },
  );

  it.each(FORMS)(
    "an unfetched handle's send and sendStream with %s",
    async (_label, ref, pinned) => {
      const bodies: unknown[] = [];
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return String(_url).endsWith("/stream")
          ? new Response(`event: done\ndata: ${JSON.stringify(wireTurn)}\n\n`)
          : Response.json(wireTurn);
      };
      const handle = makeClient(fetch).rigs.handle(ref);
      await handle.send({ message: "hi" });
      await handle.sendStream({ message: "hi" });
      const field = `sandbox_${kindOf(pinned)}`;
      expect(bodies).toEqual([
        { message: "hi", [field]: "dev/1" },
        { message: "hi", [field]: "dev/1" },
      ]);
    },
  );

  it.each(FORMS)(
    "a handle created with %s pins the fetched rig's ID",
    async (_label, ref) => {
      const { fetch, calls } = mockFetch([
        { body: wireRig },
        { body: wireRig },
        { status: 204 },
        { status: 204 },
        { status: 204 },
        { body: wireTurn },
      ]);
      const rig = await makeClient(fetch).rigs.handle(ref).fetch();
      await rig.refresh();
      await rig.start();
      await rig.stop();
      await rig.delete();
      await rig.send({ message: "hi" });
      expect(calls.slice(1).map((c) => [c.method, c.url])).toEqual([
        ["GET", `${API}/rigs/rig%2F9?by=id`],
        ["POST", `${API}/rigs/rig%2F9/start?by=id`],
        ["POST", `${API}/rigs/rig%2F9/stop?by=id`],
        ["DELETE", `${API}/rigs/rig%2F9?by=id`],
        ["POST", `${API}/agent-sessions`],
      ]);
      expect(JSON.parse(calls[5]?.body ?? "")).toEqual({
        message: "hi",
        sandbox_id: "rig/9",
      });
    },
  );

  it("a rig returned by list pins its ID", async () => {
    const { fetch, calls } = mockFetch([{ body: [wireRig] }, { status: 204 }]);
    const [rig] = await makeClient(fetch).rigs.list();
    await rig!.stop();
    expect(calls[1]?.url).toBe(`${API}/rigs/rig%2F9/stop?by=id`);
  });

  it("a rig's send overrides any rig field smuggled into the request", async () => {
    const { fetch, calls } = mockFetch([{ body: wireTurn }]);
    const handle = makeClient(fetch).rigs.handle({ ref: "dev", by: "name" });
    // Untyped callers can pass fields AgentSendRequest omits.
    await handle.send({ message: "hi", rigId: "other" } as never);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "hi",
      sandbox_name: "dev",
    });
  });

  it.each(INVALID)(
    "rejects %s before any request",
    async (_label, ref, message) => {
      const { fetch, calls } = mockFetch([]);
      const client = makeClient(fetch);
      expect(() => client.rigs.handle(ref as RigRef)).toThrow(message);
      await expect(client.rigs.get(ref as RigRef)).rejects.toThrow(message);
      await expect(client.rigs.getAndWait(ref as RigRef)).rejects.toThrow(
        message,
      );
      expect(calls).toHaveLength(0);
    },
  );

  it("never parses a kind out of the string", async () => {
    const { fetch, calls } = mockFetch([{ body: wireRig }]);
    await makeClient(fetch).rigs.get("name=dev");
    expect(calls[0]?.url).toBe(`${API}/rigs/name%3Ddev`);
  });
});

describe("services: the rig is the path's parent (sandbox_by)", () => {
  it.each(FORMS)("create with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ status: 201, body: wireService }]);
    await makeClient(fetch).services.create(ref, serviceReq);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      `${API}/rigs/dev%2F1/services${pinned ? `?sandbox_by=${pinned}` : ""}`,
    );
  });

  it.each(FORMS)(
    "replace with %s keeps the service's own by",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { body: wireService },
        { body: wireService },
      ]);
      const client = makeClient(fetch);
      await client.services.replace(ref, "web", serviceReq);
      await client.services.replace(ref, "svc_1", serviceReq, "id");
      const rigQs = pinned ? `&sandbox_by=${pinned}` : "";
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["PUT", `${API}/rigs/dev%2F1/services/web?by=name${rigQs}`],
        ["PUT", `${API}/rigs/dev%2F1/services/svc_1?by=id${rigQs}`],
      ]);
    },
  );

  it.each(FORMS)("delete with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ status: 204 }]);
    await makeClient(fetch).services.delete(ref, "web");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${API}/rigs/dev%2F1/services/web?by=name${pinned ? `&sandbox_by=${pinned}` : ""}`,
    );
  });

  it.each(FORMS)("list({ rig }) with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: { items: [] } }]);
    await makeClient(fetch).services.list({ rig: ref });
    expect(calls[0]?.url).toBe(
      `${API}/rig-services?sandbox_${kindOf(pinned)}=dev%2F1`,
    );
  });

  it("list maps the deprecated rigRef to a ref, behind a non-empty rig", async () => {
    const { fetch, calls } = mockFetch([
      { body: { items: [] } },
      { body: { items: [] } },
      { body: { items: [] } },
      { body: { items: [] } },
    ]);
    const client = makeClient(fetch);
    await client.services.list({ rigRef: "dev" });
    await client.services.list({
      rig: { ref: "rig/9", by: "id" },
      rigRef: "dev",
    });
    await client.services.list({ rig: "", rigRef: "dev" });
    // An empty deprecated alias still means no filter, as it always did.
    await client.services.list({ rigRef: "" });
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/rig-services?sandbox_ref=dev`,
      `${API}/rig-services?sandbox_id=rig%2F9`,
      `${API}/rig-services?sandbox_ref=dev`,
      `${API}/rig-services`,
    ]);
  });

  it.each(INVALID)(
    "rejects %s before any request",
    async (_label, ref, message) => {
      const { fetch, calls } = mockFetch([]);
      const client = makeClient(fetch);
      const rig = ref as RigRef;
      await expect(client.services.create(rig, serviceReq)).rejects.toThrow(
        message,
      );
      await expect(
        client.services.replace(rig, "web", serviceReq),
      ).rejects.toThrow(message);
      await expect(client.services.delete(rig, "web")).rejects.toThrow(message);
      await expect(client.services.list({ rig })).rejects.toThrow(message);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("snapshots", () => {
  it.each(FORMS)("create({ rig }) with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ status: 201, body: wireSnapshot }]);
    await makeClient(fetch).snapshots.create({ rig: ref, name: "base" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      [`sandbox_${kindOf(pinned)}`]: "dev/1",
      name: "base",
    });
  });

  it("create maps rigRef and sandboxRef to a ref, in precedence order", async () => {
    const { fetch, calls } = mockFetch(
      Array(5).fill({ status: 201, body: wireSnapshot }),
    );
    const client = makeClient(fetch);
    await client.snapshots.create({ rigRef: "a", name: "s" });
    await client.snapshots.create({ sandboxRef: "b", name: "s" });
    await client.snapshots.create({
      rig: { ref: "c", by: "name" },
      rigRef: "a",
      sandboxRef: "b",
      name: "s",
    });
    await client.snapshots.create({ rig: "", rigRef: "a", name: "s" });
    await client.snapshots.create({ rigRef: "", sandboxRef: "b", name: "s" });
    expect(calls.map((c) => JSON.parse(c.body ?? ""))).toEqual([
      { sandbox_ref: "a", name: "s" },
      { sandbox_ref: "b", name: "s" },
      { sandbox_name: "c", name: "s" },
      { sandbox_ref: "a", name: "s" },
      { sandbox_ref: "b", name: "s" },
    ]);
  });

  it.each(FORMS)("list({ sourceRig }) with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: { items: [] } }]);
    await makeClient(fetch).snapshots.list({ sourceRig: ref });
    expect(calls[0]?.url).toBe(
      `${API}/rig-snapshots?source_sandbox_${kindOf(pinned)}=dev%2F1`,
    );
  });

  it("list maps sourceRigId and sourceSandboxId to an ID, behind sourceRig", async () => {
    const { fetch, calls } = mockFetch(Array(5).fill({ body: { items: [] } }));
    const client = makeClient(fetch);
    await client.snapshots.list({ sourceRigId: "rig-a" });
    await client.snapshots.list({ sourceSandboxId: "rig-b" });
    await client.snapshots.list({ sourceRig: "dev", sourceRigId: "rig-a" });
    await client.snapshots.list({ sourceRig: "", sourceSandboxId: "rig-b" });
    await client.snapshots.list({ sourceRigId: "", sourceSandboxId: "" });
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/rig-snapshots?source_sandbox_id=rig-a`,
      `${API}/rig-snapshots?source_sandbox_id=rig-b`,
      `${API}/rig-snapshots?source_sandbox_ref=dev`,
      `${API}/rig-snapshots?source_sandbox_id=rig-b`,
      `${API}/rig-snapshots`,
    ]);
  });

  it.each(FORMS)("previewScrub with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: { files: [], env_vars: [] } }]);
    await makeClient(fetch).snapshots.previewScrub(ref);
    // The endpoint's omitted `by` means name, so a plain string sends by=ref.
    expect(calls[0]?.url).toBe(
      `${API}/rig-snapshots/scrub-preview?sandbox=dev%2F1&by=${kindOf(pinned)}`,
    );
  });

  it.each(FORMS)(
    "get and an unfetched handle's delete with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { body: wireSnapshot },
        { status: 204 },
      ]);
      const client = makeClient(fetch);
      await client.snapshots.get(ref);
      await client.snapshots.handle(ref).delete();
      const url = `${API}/rig-snapshots/dev%2F1?by=${kindOf(pinned)}`;
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["GET", url],
        ["DELETE", url],
      ]);
    },
  );

  it("a fetched snapshot pins its ID", async () => {
    const { fetch, calls } = mockFetch([
      { body: wireSnapshot },
      { status: 204 },
    ]);
    const snapshot = await makeClient(fetch).snapshots.get({
      ref: "base",
      by: "name",
    });
    await snapshot.delete();
    expect(calls[1]?.url).toBe(`${API}/rig-snapshots/snap%2F9?by=id`);
  });

  it.each(INVALID)(
    "rejects %s before any request",
    async (_label, ref, message) => {
      const { fetch, calls } = mockFetch([]);
      const client = makeClient(fetch);
      const rig = ref as RigRef;
      await expect(client.snapshots.create({ rig, name: "s" })).rejects.toThrow(
        message,
      );
      await expect(client.snapshots.previewScrub(rig)).rejects.toThrow(message);
      await expect(client.snapshots.list({ sourceRig: rig })).rejects.toThrow(
        message.replace(/^rig/, "sourceRig"),
      );
      const snapshotMessage = message.replace(/^rig/, "snapshot");
      expect(() => client.snapshots.handle(rig)).toThrow(snapshotMessage);
      await expect(client.snapshots.get(rig)).rejects.toThrow(snapshotMessage);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("agentSessions", () => {
  it.each(FORMS)("send({ rig }) with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: wireTurn }]);
    await makeClient(fetch).agentSessions.send({ message: "hi", rig: ref });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "hi",
      [`sandbox_${kindOf(pinned)}`]: "dev/1",
    });
  });

  it.each(FORMS)("sendStream({ rig }) with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([
      { body: `event: done\ndata: ${JSON.stringify(wireTurn)}\n\n` },
    ]);
    await makeClient(fetch).agentSessions.sendStream({
      message: "hi",
      rig: ref,
    });
    expect(calls[0]?.url).toBe(`${API}/agent-sessions/stream`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "hi",
      [`sandbox_${kindOf(pinned)}`]: "dev/1",
    });
  });

  it("send maps the deprecated rigId and sandboxId to an ID, behind a non-empty rig", async () => {
    const { fetch, calls } = mockFetch(Array(5).fill({ body: wireTurn }));
    const client = makeClient(fetch);
    await client.agentSessions.send({ message: "m", rigId: "rig-a" });
    await client.agentSessions.send({ message: "m", sandboxId: "rig-b" });
    await client.agentSessions.send({
      message: "m",
      rig: "dev",
      rigId: "rig-a",
      sandboxId: "rig-b",
    });
    await client.agentSessions.send({ message: "m", rig: "", rigId: "rig-a" });
    await client.agentSessions.send({
      message: "m",
      rigId: "",
      sandboxId: "rig-b",
    });
    expect(calls.map((c) => JSON.parse(c.body ?? ""))).toEqual([
      { message: "m", sandbox_id: "rig-a" },
      { message: "m", sandbox_id: "rig-b" },
      { message: "m", sandbox_ref: "dev" },
      { message: "m", sandbox_id: "rig-a" },
      { message: "m", sandbox_id: "rig-b" },
    ]);
  });

  it("send without a rig names none", async () => {
    const { fetch, calls } = mockFetch([{ body: wireTurn }]);
    await makeClient(fetch).agentSessions.send({
      message: "m",
      sessionId: "chat1",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "m",
      session_id: "chat1",
    });
  });

  it.each(FORMS)("list({ rig }) with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: { sessions: [], total: 0 } }]);
    await makeClient(fetch).agentSessions.list({ rig: ref, limit: 5 });
    expect(calls[0]?.url).toBe(
      `${API}/agent-sessions?limit=5&sandbox=dev%2F1${pinned ? `&sandbox_by=${pinned}` : ""}`,
    );
  });

  it("list maps the deprecated rigRef to a ref, behind a non-empty rig", async () => {
    const { fetch, calls } = mockFetch(
      Array(3).fill({ body: { sessions: [], total: 0 } }),
    );
    const client = makeClient(fetch);
    await client.agentSessions.list({ rigRef: "dev" });
    await client.agentSessions.list({
      rig: { ref: "rig/9", by: "id" },
      rigRef: "dev",
    });
    await client.agentSessions.list({ rig: "", rigRef: "dev" });
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/agent-sessions?sandbox=dev`,
      `${API}/agent-sessions?sandbox=rig%2F9&sandbox_by=id`,
      `${API}/agent-sessions?sandbox=dev`,
    ]);
  });

  it.each(INVALID)(
    "rejects %s before any request",
    async (_label, ref, message) => {
      const { fetch, calls } = mockFetch([]);
      const client = makeClient(fetch);
      const rig = ref as RigRef;
      await expect(
        client.agentSessions.send({ message: "m", rig }),
      ).rejects.toThrow(message);
      await expect(
        client.agentSessions.sendStream({ message: "m", rig }),
      ).rejects.toThrow(message);
      await expect(client.agentSessions.list({ rig })).rejects.toThrow(message);
      expect(calls).toHaveLength(0);
    },
  );
});

// `fetch`'s URL parser collapses dot segments, so a reference of "." or ".."
// would reach a different route than the one named (e.g. a service delete
// landing on the rig itself). They are refused before any request.
describe("dot-segment references", () => {
  it.each([".", ".."])("rejects the rig %j before any request", async (dot) => {
    const { fetch, calls } = mockFetch([]);
    const client = makeClient(fetch);
    await expect(client.rigs.get(dot)).rejects.toThrow(
      'rig must not be "." or ".."',
    );
    await expect(client.rigs.get({ ref: dot, by: "name" })).rejects.toThrow(
      'rig must not be "." or ".."',
    );
    expect(calls).toHaveLength(0);
  });

  it.each([".", ".."])(
    "rejects the service %j before any request",
    async (dot) => {
      const { fetch, calls } = mockFetch([]);
      await expect(
        makeClient(fetch).services.delete("dev", dot),
      ).rejects.toThrow('service must not be "." or ".."');
      expect(calls).toHaveLength(0);
    },
  );
});

// A blank deprecated alias in a list filter keeps its old meaning: no filter.
describe("blank deprecated list-filter aliases", () => {
  it.each(["", "  "])(
    "services.list({ rigRef: %j }) sends no filter",
    async (blank) => {
      const { fetch, calls } = mockFetch([{ body: { items: [] } }]);
      await makeClient(fetch).services.list({ rigRef: blank });
      expect(calls[0]?.url).toBe(`${API}/rig-services`);
    },
  );

  it.each(["", "  "])(
    "snapshots.list({ sourceRigId: %j }) sends no filter",
    async (blank) => {
      const { fetch, calls } = mockFetch([{ body: { items: [] } }]);
      await makeClient(fetch).snapshots.list({ sourceRigId: blank });
      expect(calls[0]?.url).toBe(`${API}/rig-snapshots`);
    },
  );

  it.each(["", "  "])(
    "agentSessions.list({ rigRef: %j }) sends no filter",
    async (blank) => {
      const { fetch, calls } = mockFetch([
        { body: { sessions: [], total: 0 } },
      ]);
      await makeClient(fetch).agentSessions.list({ rigRef: blank });
      expect(calls[0]?.url).not.toContain("sandbox");
    },
  );
});
