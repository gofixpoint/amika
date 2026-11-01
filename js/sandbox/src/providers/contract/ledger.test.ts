import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileSink, Ledger, parseLedger, type TrackedResource } from "./ledger";

const AT = new Date("2026-11-01T12:00:00Z");

function ledger() {
  const lines: string[] = [];
  return {
    lines,
    ledger: new Ledger(
      "acme",
      (l) => lines.push(l),
      () => AT,
    ),
  };
}

function resource(
  id: string,
  overrides: Partial<TrackedResource> = {},
): TrackedResource {
  return {
    kind: "sandbox",
    id,
    name: `name-${id}`,
    test: "some test",
    delete: async () => {},
    verifyGone: async () => true,
    ...overrides,
  };
}

describe("Ledger", () => {
  it("writes a created line as soon as a resource is tracked", () => {
    const { lines, ledger: l } = ledger();
    l.track(resource("sb-1"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      event: "created",
      kind: "sandbox",
      provider: "acme",
      id: "sb-1",
      name: "name-sb-1",
      test: "some test",
      at: AT.toISOString(),
    });
  });

  it("deletes newest first and records each verified deletion", async () => {
    const { ledger: l } = ledger();
    const order: string[] = [];
    l.track(
      resource("first", { delete: async () => void order.push("first") }),
    );
    l.track(
      resource("second", { delete: async () => void order.push("second") }),
    );
    await l.release();
    expect(order).toEqual(["second", "first"]);
    expect(l.events.filter((e) => e.event === "deleted")).toEqual([
      {
        event: "deleted",
        kind: "sandbox",
        id: "second",
        verified: true,
        at: AT.toISOString(),
      },
      {
        event: "deleted",
        kind: "sandbox",
        id: "first",
        verified: true,
        at: AT.toISOString(),
      },
    ]);
    expect(l.leaked).toEqual([]);
  });

  it("records a delete that throws and keeps going", async () => {
    const { ledger: l } = ledger();
    const deleted: string[] = [];
    l.track(resource("ok", { delete: async () => void deleted.push("ok") }));
    l.track(
      resource("bad", {
        delete: async () => {
          throw new Error("502 Bad Gateway");
        },
      }),
    );
    await l.release();
    expect(deleted).toEqual(["ok"]);
    expect(l.events.at(-2)).toMatchObject({
      event: "delete_failed",
      id: "bad",
      error: "502 Bad Gateway",
    });
    expect(l.events.at(-1)).toMatchObject({ event: "deleted", id: "ok" });
  });

  it("treats a resource the provider still reports as a failed delete", async () => {
    const { ledger: l } = ledger();
    l.track(resource("sticky", { verifyGone: async () => false }));
    await l.release();
    expect(l.events.at(-1)).toMatchObject({
      event: "delete_failed",
      id: "sticky",
      error: expect.stringContaining("still reports"),
    });
  });

  it("records when deletion cannot be verified", async () => {
    const { ledger: l } = ledger();
    l.track(resource("blind", { verifyGone: undefined }));
    await l.release();
    expect(l.events.at(-1)).toMatchObject({
      event: "deleted",
      id: "blind",
      verified: "unsupported",
    });
  });

  it("lists created resources with no outcome as leaked", async () => {
    const { ledger: l } = ledger();
    l.track(resource("gone"));
    await l.release();
    l.track(resource("open"));
    expect(l.leaked.map((e) => e.id)).toEqual(["open"]);
  });
});

describe("fileSink and parseLedger", () => {
  it("appends one JSON line per event and reads them back", () => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "ledger-")),
      "run",
      "audit.jsonl",
    );
    const l = new Ledger("acme", fileSink(file), () => AT);
    l.track(resource("sb-1"));
    l.track(resource("sb-2"));
    const events = parseLedger(readFileSync(file, "utf8"));
    expect(events.map((e) => e.id)).toEqual(["sb-1", "sb-2"]);
  });
});
