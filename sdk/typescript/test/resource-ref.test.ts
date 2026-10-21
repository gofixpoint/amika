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

/**
 * Each accepted form for the value "dev/1", with the kind it pins (if any).
 * A `/rigs/{ref}` path omits `by` for a plain string but sends it for every
 * pinned kind, including `ref`, so those methods run all four forms.
 */
const FORMS: [label: string, ref: RigRef, pinned: RefKind | undefined][] = [
  ["a plain string", "dev/1", undefined],
  ['{ by: "name" }', { ref: "dev/1", by: "name" }, "name"],
  ['{ by: "id" }', { ref: "dev/1", by: "id" }, "id"],
  ['{ by: "ref" }', { ref: "dev/1", by: "ref" }, "ref"],
];

/**
 * Body fields and query filters only branch on plain versus pinned, so they
 * run one of each. The `{ by: "name" }` cases in the alias and smuggled-field
 * tests prove the field name follows the kind.
 */
const PLAIN_AND_PINNED = [FORMS[0]!, FORMS[2]!];

/** The kind a form resolves to on the wire. A plain string is a ref. */
const kindOf = (pinned: RefKind | undefined): RefKind => pinned ?? "ref";

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
const wireTurnStream = `event: done\ndata: ${JSON.stringify(wireTurn)}\n\n`;
const serviceReq = { name: "web", port: 3000, urlScheme: "https" as const };

describe("reference validation", () => {
  // normalizeRef is the one validator behind every method, so the full table
  // of invalid references runs through one of them.
  it.each([
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
  ])("rejects %s before any request", async (_label, ref, message) => {
    const { fetch, calls } = mockFetch([]);
    await expect(makeClient(fetch).rigs.get(ref as RigRef)).rejects.toThrow(
      message,
    );
    expect(calls).toHaveLength(0);
  });

  it("every method rejects a blank reference, under its own label", async () => {
    const { fetch, calls } = mockFetch([]);
    const c = makeClient(fetch);
    const blank = " \t";
    const methods: [label: string, call: () => unknown][] = [
      ["rig", () => c.rigs.handle(blank)],
      ["rig", () => c.rigs.getAndWait(blank)],
      ["rig", () => c.services.create(blank, serviceReq)],
      ["rig", () => c.services.replace(blank, "web", serviceReq)],
      ["rig", () => c.services.delete(blank, "web")],
      ["rig", () => c.services.list({ rig: blank })],
      ["rig", () => c.snapshots.create({ rig: blank, name: "s" })],
      ["rig", () => c.snapshots.previewScrub(blank)],
      ["sourceRig", () => c.snapshots.list({ sourceRig: blank })],
      ["snapshot", () => c.snapshots.handle(blank)],
      ["snapshot", () => c.snapshots.get(blank)],
      ["rig", () => c.agentSessions.send({ message: "m", rig: blank })],
      ["rig", () => c.agentSessions.sendStream({ message: "m", rig: blank })],
      ["rig", () => c.agentSessions.list({ rig: blank })],
    ];
    for (const [label, call] of methods) {
      // Handles throw synchronously; the async methods reject.
      await expect(Promise.resolve().then(call)).rejects.toThrow(
        `${label} must not be empty`,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("never parses a kind out of the string", async () => {
    const { fetch, calls } = mockFetch([{ body: wireRig }]);
    await makeClient(fetch).rigs.get("name=dev");
    expect(calls[0]?.url).toBe(`${API}/rigs/name%3Ddev`);
  });

  // `fetch`'s URL parser collapses dot segments, so a reference of "." or ".."
  // would reach a different route than the one named (e.g. a service delete
  // landing on the rig itself). They are refused before any request.
  it.each([".", ".."])("rejects the dot segment %j", async (dot) => {
    const { fetch, calls } = mockFetch([]);
    const client = makeClient(fetch);
    const rigMessage = 'rig must not be "." or ".."';
    await expect(client.rigs.get(dot)).rejects.toThrow(rigMessage);
    await expect(client.rigs.get({ ref: dot, by: "name" })).rejects.toThrow(
      rigMessage,
    );
    await expect(client.services.delete("dev", dot)).rejects.toThrow(
      'service must not be "." or ".."',
    );
    expect(calls).toHaveLength(0);
  });
});

describe("rigs: the rig is the path's primary resource (by)", () => {
  it.each(FORMS)("get and getAndWait with %s", async (_label, ref, pinned) => {
    const { fetch, calls } = mockFetch([{ body: wireRig }, { body: wireRig }]);
    const client = makeClient(fetch);
    await client.rigs.get(ref);
    await client.rigs.getAndWait(ref);
    // A plain string omits `by`: the server's default is already ref.
    const url = `${API}/rigs/dev%2F1${pinned ? `?by=${pinned}` : ""}`;
    expect(calls.map((c) => c.url)).toEqual([url, url]);
  });

  it.each(FORMS)(
    "an unfetched handle's start, stop, and delete with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch(Array(3).fill({ status: 204 }));
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

  it.each(PLAIN_AND_PINNED)(
    "an unfetched handle's send and sendStream with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { body: wireTurn },
        { body: wireTurnStream },
      ]);
      const handle = makeClient(fetch).rigs.handle(ref);
      await handle.send({ message: "hi" });
      await handle.sendStream({ message: "hi" });
      const body = { message: "hi", [`sandbox_${kindOf(pinned)}`]: "dev/1" };
      expect(calls.map((c) => JSON.parse(c.body ?? ""))).toEqual([body, body]);
    },
  );

  it("a fetched handle pins the rig's ID", async () => {
    const { fetch, calls } = mockFetch([
      { body: wireRig },
      { body: wireRig },
      { status: 204 },
      { status: 204 },
      { status: 204 },
      { body: wireTurn },
    ]);
    const rig = await makeClient(fetch).rigs.handle("dev").fetch();
    await rig.refresh();
    await rig.start();
    await rig.stop();
    await rig.delete();
    await rig.send({ message: "hi" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${API}/rigs/dev`],
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
  });

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
});

describe("services: the rig is the path's parent (sandbox_by)", () => {
  it.each(FORMS)(
    "create, replace, and delete with %s keep the service's own by",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { status: 201, body: wireService },
        { body: wireService },
        { body: wireService },
        { status: 204 },
      ]);
      const client = makeClient(fetch);
      await client.services.create(ref, serviceReq);
      await client.services.replace(ref, "web", serviceReq);
      await client.services.replace(ref, "svc_1", serviceReq, "id");
      await client.services.delete(ref, "web");
      const rigQs = pinned ? `sandbox_by=${pinned}` : "";
      const svc = `${API}/rigs/dev%2F1/services`;
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ["POST", `${svc}${rigQs && `?${rigQs}`}`],
        ["PUT", `${svc}/web?by=name${rigQs && `&${rigQs}`}`],
        ["PUT", `${svc}/svc_1?by=id${rigQs && `&${rigQs}`}`],
        ["DELETE", `${svc}/web?by=name${rigQs && `&${rigQs}`}`],
      ]);
    },
  );

  it.each(PLAIN_AND_PINNED)(
    "list({ rig }) with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([{ body: { items: [] } }]);
      await makeClient(fetch).services.list({ rig: ref });
      expect(calls[0]?.url).toBe(
        `${API}/rig-services?sandbox_${kindOf(pinned)}=dev%2F1`,
      );
    },
  );

  it("list maps the deprecated rigRef to a ref, behind a non-empty rig", async () => {
    const { fetch, calls } = mockFetch(Array(5).fill({ body: { items: [] } }));
    const client = makeClient(fetch);
    await client.services.list({ rigRef: "dev" });
    await client.services.list({
      rig: { ref: "rig/9", by: "id" },
      rigRef: "dev",
    });
    await client.services.list({ rig: "", rigRef: "dev" });
    // A blank deprecated alias still means no filter, as it always did.
    await client.services.list({ rigRef: "" });
    await client.services.list({ rigRef: "  " });
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/rig-services?sandbox_ref=dev`,
      `${API}/rig-services?sandbox_id=rig%2F9`,
      `${API}/rig-services?sandbox_ref=dev`,
      `${API}/rig-services`,
      `${API}/rig-services`,
    ]);
  });
});

describe("snapshots", () => {
  it.each(PLAIN_AND_PINNED)(
    "the rig in create, list, and previewScrub with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { status: 201, body: wireSnapshot },
        { body: { items: [] } },
        { body: { files: [], env_vars: [] } },
      ]);
      const client = makeClient(fetch);
      await client.snapshots.create({ rig: ref, name: "base" });
      await client.snapshots.list({ sourceRig: ref });
      await client.snapshots.previewScrub(ref);
      const kind = kindOf(pinned);
      expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
        [`sandbox_${kind}`]: "dev/1",
        name: "base",
      });
      // previewScrub's omitted `by` means name, so a plain string sends by=ref.
      expect(calls.slice(1).map((c) => c.url)).toEqual([
        `${API}/rig-snapshots?source_sandbox_${kind}=dev%2F1`,
        `${API}/rig-snapshots/scrub-preview?sandbox=dev%2F1&by=${kind}`,
      ]);
    },
  );

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

  it("list maps sourceRigId and sourceSandboxId to an ID, behind sourceRig", async () => {
    const { fetch, calls } = mockFetch(Array(6).fill({ body: { items: [] } }));
    const client = makeClient(fetch);
    await client.snapshots.list({ sourceRigId: "rig-a" });
    await client.snapshots.list({ sourceSandboxId: "rig-b" });
    await client.snapshots.list({ sourceRig: "dev", sourceRigId: "rig-a" });
    await client.snapshots.list({ sourceRig: "", sourceSandboxId: "rig-b" });
    // A blank deprecated alias still means no filter, as it always did.
    await client.snapshots.list({ sourceRigId: "", sourceSandboxId: "" });
    await client.snapshots.list({ sourceRigId: "  " });
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/rig-snapshots?source_sandbox_id=rig-a`,
      `${API}/rig-snapshots?source_sandbox_id=rig-b`,
      `${API}/rig-snapshots?source_sandbox_ref=dev`,
      `${API}/rig-snapshots?source_sandbox_id=rig-b`,
      `${API}/rig-snapshots`,
      `${API}/rig-snapshots`,
    ]);
  });

  it.each(PLAIN_AND_PINNED)(
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
});

describe("agentSessions", () => {
  it.each(PLAIN_AND_PINNED)(
    "send, sendStream, and list({ rig }) with %s",
    async (_label, ref, pinned) => {
      const { fetch, calls } = mockFetch([
        { body: wireTurn },
        { body: wireTurnStream },
        { body: { sessions: [], total: 0 } },
      ]);
      const client = makeClient(fetch);
      await client.agentSessions.send({ message: "hi", rig: ref });
      await client.agentSessions.sendStream({ message: "hi", rig: ref });
      await client.agentSessions.list({ rig: ref, limit: 5 });
      expect(calls.map((c) => c.url)).toEqual([
        `${API}/agent-sessions`,
        `${API}/agent-sessions/stream`,
        `${API}/agent-sessions?limit=5&sandbox=dev%2F1${pinned ? `&sandbox_by=${pinned}` : ""}`,
      ]);
      const body = { message: "hi", [`sandbox_${kindOf(pinned)}`]: "dev/1" };
      expect(calls.slice(0, 2).map((c) => JSON.parse(c.body ?? ""))).toEqual([
        body,
        body,
      ]);
    },
  );

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

  it("list maps the deprecated rigRef to a ref, behind a non-empty rig", async () => {
    const { fetch, calls } = mockFetch(
      Array(5).fill({ body: { sessions: [], total: 0 } }),
    );
    const client = makeClient(fetch);
    await client.agentSessions.list({ rigRef: "dev" });
    await client.agentSessions.list({
      rig: { ref: "rig/9", by: "id" },
      rigRef: "dev",
    });
    await client.agentSessions.list({ rig: "", rigRef: "dev" });
    // A blank deprecated alias still means no filter, as it always did.
    await client.agentSessions.list({ rigRef: "" });
    await client.agentSessions.list({ rigRef: "  " });
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/agent-sessions?sandbox=dev`,
      `${API}/agent-sessions?sandbox=rig%2F9&sandbox_by=id`,
      `${API}/agent-sessions?sandbox=dev`,
      `${API}/agent-sessions`,
      `${API}/agent-sessions`,
    ]);
  });
});
