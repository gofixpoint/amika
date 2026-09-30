import { describe, expect, it } from "vitest";
import { AmikaClient } from "@/index";
import { mockFetch } from "@test/helpers";

describe("grouped and bound operations", () => {
  it("routes rig sends and chat continuations with model/effort options", async () => {
    const { fetch, calls } = mockFetch([
      { body: { session_id: "chat/1", sandbox_id: "rig1", response: "first" } },
      { body: { session_id: "chat/1", sandbox_id: "rig1", messages: [] } },
      { body: { session_id: "chat/1", response: "second" } },
      {
        body: {
          session_id: "chat/1",
          messages: [{ role: "assistant", content: "second" }],
        },
      },
    ]);
    const client = new AmikaClient({ apiKey: "test-key", fetch });
    const turn = await client.rigs
      .handle("rig1")
      .send({ message: "first", model: "model1", effort: "high" });
    const session = await client.agentSessions.get(turn.sessionId);
    await session.send({ message: "second", model: null, effort: null });
    expect(await session.refresh()).toBe(session);
    expect(session.messages[0]?.content).toBe("second");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      message: "first",
      sandbox_id: "rig1",
      model: "model1",
      effort: "high",
    });
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      message: "second",
      session_id: "chat/1",
      model: null,
      effort: null,
    });
    expect(calls[1]?.url).toContain("agent-sessions/chat%2F1");
    expect(JSON.stringify(session)).not.toMatch(/test-key|refresh|send/);
  });

  it("binds streaming sends to rigs and chats", async () => {
    const bodies: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET")
        return Response.json({ session_id: "chat1", messages: [] });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        'event: delta\ndata: {"text":"hello"}\n\nevent: done\ndata: {"session_id":"chat1","response":"hello"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    const client = new AmikaClient({ apiKey: "test-key", fetch });
    const deltas: string[] = [];
    await client.rigs
      .handle("rig1")
      .sendStream({ message: "hi" }, { onDelta: (text) => deltas.push(text) });
    const session = await client.agentSessions.get("chat1");
    await session.sendStream({ message: "again" });
    expect(deltas).toEqual(["hello"]);
    expect(bodies).toEqual([
      { message: "hi", sandbox_id: "rig1" },
      { message: "again", session_id: "chat1" },
    ]);
  });

  it("keeps list totals and uses named options", async () => {
    const { fetch, calls } = mockFetch([
      { body: { sessions: [], total: 100 } },
      { body: { items: [] } },
      { body: { items: [] } },
    ]);
    const client = new AmikaClient({ apiKey: "test-key", fetch });
    expect(await client.agentSessions.list({ limit: 1 })).toEqual({
      sessions: [],
      total: 100,
    });
    await client.services.list({ rigRef: "a/b" });
    await client.snapshots.list({ sourceRigId: "rig1", repositoryId: "repo1" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://app.amika.dev/api/v0beta1/agent-sessions?limit=1",
      "https://app.amika.dev/api/v0beta1/rig-services?sandbox_ref=a%2Fb",
      "https://app.amika.dev/api/v0beta1/rig-snapshots?repository_id=repo1&source_sandbox_id=rig1",
    ]);
  });

  it("validates reserved ports before making requests through either write operation", async () => {
    const { fetch, calls } = mockFetch([]);
    const client = new AmikaClient({ apiKey: "test-key", fetch });
    const request = { name: "web", port: 60999, urlScheme: "http" as const };
    await expect(client.services.create("dev", request)).rejects.toThrow(
      /reserved/,
    );
    await expect(
      client.services.replace("dev", "web", request),
    ).rejects.toThrow(/reserved/);
    expect(calls).toEqual([]);
  });
});
