import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InstaboxApiError,
  InstaboxOperationError,
  retryDelayMs,
  runOperation,
  send,
} from "./client";

const CONFIG = { apiKey: "ibk_test", apiUrl: "https://ib.test" };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** Stub `fetch` with answers given in order; record each call. */
function stubFetch(...answers: Array<[number, unknown]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        method: init.method ?? "GET",
        url,
        headers: init.headers as Record<string, string>,
      });
      const next = answers.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      const [status, body] = next;
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

const apiError = (code: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message: code, ...extra },
});

const op = (
  id: string,
  state: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  machineId: "m_1",
  type: "stop",
  state,
  error: null,
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("send", () => {
  it("turns an error body into an InstaboxApiError", async () => {
    stubFetch([409, apiError("machine_not_running")]);
    const error = await send(CONFIG, "POST", "/machines/m_1/exec").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InstaboxApiError);
    expect(error).toMatchObject({ status: 409, code: "machine_not_running" });
  });

  it("retries a retryable error with the same idempotency key", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(
      [503, apiError("no_capacity", { retryable: true, retryAfterSeconds: 1 })],
      [200, { ok: true }],
    );
    const pending = send(CONFIG, "POST", "/machines", { idempotent: true });
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["Idempotency-Key"]).toBeTruthy();
    expect(calls[1].headers["Idempotency-Key"]).toBe(
      calls[0].headers["Idempotency-Key"],
    );
    expect(calls[0].headers["X-API-Key"]).toBe("ibk_test");
    expect(calls[0].url).toBe("https://ib.test/v1/machines");
  });

  it("does not retry an error that is not retryable", async () => {
    const calls = stubFetch([400, apiError("bad_request")]);
    await expect(send(CONFIG, "GET", "/machines")).rejects.toThrow(
      /bad_request/,
    );
    expect(calls).toHaveLength(1);
  });

  it("does not retry a POST without a key, which may have run", async () => {
    const calls = stubFetch([
      503,
      apiError("unavailable", { retryable: true }),
    ]);
    await expect(send(CONFIG, "POST", "/machines/m_1/exec")).rejects.toThrow(
      /unavailable/,
    );
    expect(calls).toHaveLength(1);
  });

  it("retries a POST without a key on 429, which ran nothing", async () => {
    vi.useFakeTimers();
    const calls = stubFetch(
      [429, apiError("rate_limited", { retryable: true })],
      [200, { ok: true }],
    );
    const pending = send(CONFIG, "POST", "/machines/m_1/exec");
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("retryDelayMs", () => {
  it("uses Retry-After when present, else backs off, with a cap", () => {
    const withAfter = new InstaboxApiError(503, "x", "x", {
      retryAfterSeconds: 2,
    });
    expect(retryDelayMs(withAfter, 1)).toBe(2000);
    const plain = new InstaboxApiError(503, "x", "x");
    expect(retryDelayMs(plain, 1)).toBe(1000);
    expect(retryDelayMs(plain, 3)).toBe(4000);
    const long = new InstaboxApiError(503, "x", "x", {
      retryAfterSeconds: 600,
    });
    expect(retryDelayMs(long, 1)).toBe(60_000);
  });
});

describe("runOperation", () => {
  it("waits out a blocking operation, then runs its own", async () => {
    const calls = stubFetch(
      [409, apiError("operation_conflict", { operationId: "op_other" })],
      [200, op("op_other", "succeeded")],
      [202, op("op_mine", "queued")],
      [200, op("op_mine", "running")],
      [200, op("op_mine", "succeeded")],
    );
    const result = await runOperation(CONFIG, "POST", "/machines/m_1/stop");
    expect(result.id).toBe("op_mine");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v1/machines/m_1/stop",
      "GET /v1/operations/op_other",
      "POST /v1/machines/m_1/stop",
      "GET /v1/operations/op_mine",
      "GET /v1/operations/op_mine",
    ]);
  });

  it("throws when the operation fails", async () => {
    stubFetch(
      [202, op("op_1", "queued")],
      [
        200,
        op("op_1", "failed", {
          error: { code: "no_capacity", message: "full" },
        }),
      ],
    );
    await expect(
      runOperation(CONFIG, "POST", "/machines/m_1/start"),
    ).rejects.toBeInstanceOf(InstaboxOperationError);
  });
});
