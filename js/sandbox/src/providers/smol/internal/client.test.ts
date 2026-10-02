/** Verify URL, deadline, and error handling at the local API boundary. */
import { describe, expect, it, vi } from "vitest";
import { SmolClient, filePath } from "./client";

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

  it("surfaces the error message of a refused request", async () => {
    const error =
      'image "amika-coder" is not configured on this host; add it under [preset_images] in /etc/amika-hostd/config.toml';
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error }, { status: 400 }));
    await expect(
      new SmolClient({}, fetcher).request("", "POST", { name: "demo" }),
    ).rejects.toMatchObject({
      status: 400,
      message: `smolvm POST  failed (HTTP 400): ${error}`,
    });
  });

  it.each([
    ["a non-JSON body", () => new Response("Bad Request", { status: 400 })],
    ["an empty body", () => new Response(null, { status: 400 })],
    ["JSON without an error", () => Response.json({}, { status: 400 })],
    [
      "a non-string error",
      () => Response.json({ error: { code: 1 } }, { status: 400 }),
    ],
    ["an empty error", () => Response.json({ error: "" }, { status: 400 })],
  ])("falls back to the status for %s", async (_label, response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    await expect(
      new SmolClient({}, fetcher).request("/machine/start", "POST"),
    ).rejects.toThrow(/^smolvm POST \/machine\/start failed \(HTTP 400\)$/);
  });

  it("never surfaces an exec error's message, which may echo the command", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "sensitive command contents" }, { status: 500 }),
      );
    await expect(
      new SmolClient({}, fetcher).request("/machine/exec", "POST", {}),
    ).rejects.toThrow(/^smolvm POST \/machine\/exec failed \(HTTP 500\)$/);
  });

  it("surfaces the message for a file named exec", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    await expect(
      new SmolClient({}, fetcher).request(filePath("machine", "/tmp/exec")),
    ).rejects.toThrow(
      /^smolvm GET \/machine\/files\/tmp\/exec failed \(HTTP 401\): Unauthorized$/,
    );
  });

  it("never includes the request body or headers in an error", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "Nope" }, { status: 400 }));
    const failure = new SmolClient({}, fetcher).request("", "POST", {
      name: "demo",
      token: "do-not-print",
    });
    await expect(failure).rejects.toThrow(
      "smolvm POST  failed (HTTP 400): Nope",
    );
    await expect(failure).rejects.not.toThrow(/do-not-print|Content-Type/);
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
