/** Verify URL, deadline, and error handling at the local API boundary. */
import { describe, expect, it, vi } from "vitest";
import { SmolClient } from "./client";

describe("SmolClient", () => {
  it("uses the configured runtime and deadline without authentication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const client = new SmolClient(
      { apiUrl: "http://localhost:9000/", requestTimeoutMs: 1234 },
      fetcher,
    );
    await client.discard("/machine/start", "POST");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9000/api/v1/machines/machine/start",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetcher.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it("does not expose a server's error body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("sensitive command contents", { status: 500 }),
      );
    await expect(
      new SmolClient({}, fetcher).request("/machine/exec", "POST", {}),
    ).rejects.toThrow(/^smolvm POST \/machine\/exec failed \(HTTP 500\)$/);
  });

  it.each([
    "file:///tmp/runtime",
    "http://user:pass@localhost",
    "http://localhost/?token=secret",
    "http://localhost/#fragment",
  ])("rejects invalid origins: %s", (apiUrl) => {
    expect(() => new SmolClient({ apiUrl })).toThrow();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects invalid deadlines: %s",
    (requestTimeoutMs) => {
      expect(() => new SmolClient({ requestTimeoutMs })).toThrow();
    },
  );
});
