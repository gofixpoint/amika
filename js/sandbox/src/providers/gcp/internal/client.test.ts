import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GcpApiError,
  GcpOperationError,
  gcpTarget,
  requestJson,
  runOperation,
} from "./client";
import { z } from "zod";
import { GOOGLE_TOKEN_URI } from "./credentials";
import { TEST_CONFIG } from "./test-key";

afterEach(() => vi.unstubAllGlobals());

/** Stub `fetch`: the token endpoint answers a token, the rest in order. */
function stubFetch(...answers: Array<[number, unknown]>) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      if (String(url) === GOOGLE_TOKEN_URI) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
        );
      }
      calls.push({ method: init.method ?? "GET", url: String(url) });
      const next = answers.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return new Response(JSON.stringify(next[1]), { status: next[0] });
    }),
  );
  return calls;
}

const target = gcpTarget(TEST_CONFIG);

describe("requestJson", () => {
  it("turns an error body into a GcpApiError with its reason", async () => {
    stubFetch([
      404,
      {
        error: { code: 404, message: "gone", errors: [{ reason: "notFound" }] },
      },
    ]);
    const err = await requestJson(target, z.object({}), "GET", "x").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GcpApiError);
    expect(err).toMatchObject({ status: 404, reason: "notFound" });
  });

  it("does not retry a POST that is not repeatable", async () => {
    const calls = stubFetch([503, { error: { message: "busy" } }]);
    await expect(
      requestJson(target, z.object({}), "POST", "x"),
    ).rejects.toThrow(/503/);
    expect(calls).toHaveLength(1);
  });
});

describe("runOperation", () => {
  it("sends a requestId and waits on the zone operation", async () => {
    const calls = stubFetch(
      [200, { name: "op-1", status: "RUNNING", zone: "z" }],
      [200, { name: "op-1", status: "DONE", zone: "z" }],
    );
    const op = await runOperation(
      target,
      "POST",
      `${target.zonePath}/instances`,
      { json: {} },
    );
    expect(op.status).toBe("DONE");
    expect(calls[0].url).toMatch(/requestId=/);
    expect(calls[1].url).toBe(
      "https://compute.test/compute/v1/projects/acme-proj/zones/us-central1-a/operations/op-1/wait",
    );
  });

  it("waits on a global operation for an image", async () => {
    const calls = stubFetch(
      [200, { name: "op-2", status: "PENDING" }],
      [200, { name: "op-2", status: "DONE" }],
    );
    await runOperation(target, "POST", `${target.projectPath}/global/images`);
    expect(calls[1].url).toBe(
      "https://compute.test/compute/v1/projects/acme-proj/global/operations/op-2/wait",
    );
  });

  it("throws when the operation ends with errors", async () => {
    stubFetch([
      200,
      {
        name: "op-3",
        status: "DONE",
        zone: "z",
        error: { errors: [{ code: "QUOTA_EXCEEDED", message: "no CPUs" }] },
      },
    ]);
    await expect(
      runOperation(target, "POST", `${target.zonePath}/instances`),
    ).rejects.toBeInstanceOf(GcpOperationError);
  });
});
