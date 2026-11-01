import { describe, expect, it } from "vitest";
import { renderMarkdown, renderText, summarize } from "./audit-report";
import type { LedgerEvent } from "./ledger";

const AT = "2026-11-01T12:00:00.000Z";

function created(
  id: string,
  kind: "sandbox" | "snapshot" = "sandbox",
): LedgerEvent {
  return {
    event: "created",
    kind,
    provider: "acme",
    id,
    name: `name-${id}`,
    test: `test ${id}`,
    at: AT,
  };
}

describe("summarize", () => {
  it("gives each created resource one row with its final outcome", () => {
    const summary = summarize([
      created("a"),
      created("b"),
      created("c", "snapshot"),
      created("d"),
      { event: "deleted", kind: "sandbox", id: "a", verified: true, at: AT },
      {
        event: "deleted",
        kind: "sandbox",
        id: "b",
        verified: "unsupported",
        at: AT,
      },
      {
        event: "delete_failed",
        kind: "snapshot",
        id: "c",
        error: "502",
        at: AT,
      },
    ]);
    expect(summary.rows.map((r) => [r.id, r.outcome, r.detail])).toEqual([
      ["a", "deleted", ""],
      ["b", "deleted (unverified)", ""],
      ["c", "LEAKED", "502"],
      ["d", "LEAKED", expect.stringContaining("no deletion recorded")],
    ]);
    expect(summary).toMatchObject({ created: 4, deleted: 2, leaked: 2 });
  });

  it("ignores outcomes for resources it never saw created", () => {
    const summary = summarize([
      {
        event: "deleted",
        kind: "sandbox",
        id: "ghost",
        verified: true,
        at: AT,
      },
    ]);
    expect(summary.rows).toEqual([]);
  });
});

describe("renderText", () => {
  it("aligns columns and ends with totals and the ledger path", () => {
    const summary = summarize([
      created("sb-1"),
      { event: "deleted", kind: "sandbox", id: "sb-1", verified: true, at: AT },
    ]);
    const text = renderText(summary, {
      runId: "r1",
      file: "/runs/r1/audit.jsonl",
    });
    expect(text.split("\n")).toEqual([
      "Provider contract audit  run=r1",
      "KIND     PROVIDER  ID    NAME       CREATED IN  OUTCOME",
      "sandbox  acme      sb-1  name-sb-1  test sb-1   deleted",
      "1 created, 1 deleted, 0 leaked",
      "Ledger: /runs/r1/audit.jsonl",
    ]);
  });

  it("says so when nothing was created", () => {
    const text = renderText(summarize([]), { runId: "r1", file: "f" });
    expect(text).toContain("No resources were created.");
    expect(text).toContain("0 created, 0 deleted, 0 leaked");
  });
});

describe("renderMarkdown", () => {
  it("renders a table and escapes pipes in cells", () => {
    const events: LedgerEvent[] = [
      created("sb-1"),
      {
        event: "delete_failed",
        kind: "sandbox",
        id: "sb-1",
        error: "a | b",
        at: AT,
      },
    ];
    const md = renderMarkdown(summarize(events), { runId: "r1" });
    expect(md).toContain(
      "| KIND | PROVIDER | ID | NAME | CREATED IN | OUTCOME |",
    );
    expect(md).toContain(
      "| sandbox | acme | sb-1 | name-sb-1 | test sb-1 | LEAKED: a \\| b |",
    );
    expect(md).toContain("1 created, 0 deleted, 1 LEAKED");
  });
});
