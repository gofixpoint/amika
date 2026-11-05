import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxCtx } from "../../../logger";
import { createInstaboxSandbox } from "./operations";

const CONFIG = { apiKey: "ibk_test", apiUrl: "https://ib.test" };
const logger = { info: vi.fn(), warn: vi.fn() };
const ctx = { logger, childCtx: () => ctx } as unknown as SandboxCtx;
const INPUT = { name: "rig-1", snapshot: "sn_base", services: [] };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

/**
 * Stub the Instabox API. `create` answers `POST /machines`. The machine
 * list holds one machine from this create call and one older machine with
 * the same name. Return the requests as "METHOD path".
 */
function stubApi(create: () => Response): string[] {
  const requests: string[] = [];
  let createId = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const path = new URL(url).pathname.replace(/^\/v1/, "");
      requests.push(`${method} ${path}`);
      if (method === "POST" && path === "/machines") {
        const body = JSON.parse(init.body as string) as {
          metadata: Record<string, string>;
        };
        createId = body.metadata["amika-create-id"];
        return create();
      }
      if (method === "GET" && path === "/machines") {
        return json(200, {
          machines: [
            {
              id: "m_ours",
              name: "rig-1",
              state: "creating",
              metadata: { "amika-create-id": createId },
            },
            {
              id: "m_older",
              name: "rig-1",
              state: "running",
              metadata: { "amika-create-id": "another-call" },
            },
          ],
        });
      }
      if (method === "DELETE") {
        const machineId = path.split("/")[2];
        return json(200, {
          id: "op_delete",
          machineId,
          type: "delete",
          state: "pending",
          error: null,
        });
      }
      if (method === "GET" && path.startsWith("/operations/")) {
        return json(200, {
          id: "op_delete",
          type: "delete",
          state: "succeeded",
          error: null,
        });
      }
      throw new Error(`unexpected request ${method} ${path}`);
    }),
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createInstaboxSandbox cleanup", () => {
  it("deletes the machine this call made when the outcome is unknown", async () => {
    vi.useFakeTimers();
    const requests = stubApi(() => {
      throw new TypeError("fetch failed");
    });
    const pending = createInstaboxSandbox(ctx, CONFIG, INPUT).catch(
      (e: unknown) => e,
    );
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(TypeError);
    expect(requests).toContain("DELETE /machines/m_ours");
    expect(requests).not.toContain("DELETE /machines/m_older");
  });

  it("looks for nothing when Instabox refuses the create", async () => {
    const requests = stubApi(() =>
      json(409, { error: { code: "name_taken", message: "name taken" } }),
    );
    await expect(createInstaboxSandbox(ctx, CONFIG, INPUT)).rejects.toThrow(
      /name_taken/,
    );
    expect(requests).toEqual(["POST /machines"]);
  });
});
