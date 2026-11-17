import { afterEach, describe, expect, it, vi } from "vitest";
import { bootSource } from "./operations";

const CONFIG = { apiKey: "ibk_test", apiUrl: "https://ib.test" };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

/** Stub `GET /templates` and `GET /snapshots`; return the request paths. */
function stubApi(templates: string[], snapshots: string[]): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname.replace(/^\/v1/, "");
      paths.push(path);
      if (path === "/templates") {
        return json({ templates: templates.map((id) => ({ id })) });
      }
      if (path === "/snapshots") {
        return json({
          snapshots: snapshots.map((name, i) => ({
            id: `sn_${i}`,
            name,
            status: "ready",
          })),
        });
      }
      throw new Error(`unexpected ${path}`);
    }),
  );
  return paths;
}

afterEach(() => vi.unstubAllGlobals());

describe("bootSource", () => {
  it("uses a snapshot id as is", async () => {
    const paths = stubApi([], []);
    expect(await bootSource(CONFIG, "sn_abc")).toEqual({
      snapshotId: "sn_abc",
    });
    expect(paths).toEqual([]);
  });

  it("prefers a template over a snapshot with the same name", async () => {
    stubApi(["ci"], ["ci"]);
    expect(await bootSource(CONFIG, "ci")).toEqual({ templateId: "ci" });
  });

  it("matches a pinned template by its id", async () => {
    stubApi(["ci"], []);
    expect(await bootSource(CONFIG, "ci@2026-10-02.1")).toEqual({
      templateId: "ci@2026-10-02.1",
    });
  });

  it("falls back to a snapshot by name", async () => {
    stubApi(["ci"], ["my-image"]);
    expect(await bootSource(CONFIG, "my-image")).toEqual({
      snapshotId: "sn_0",
    });
  });

  it("sends an unknown name as a template", async () => {
    stubApi(["ci"], []);
    expect(await bootSource(CONFIG, "nope")).toEqual({ templateId: "nope" });
  });
});
