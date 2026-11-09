import { describe, expect, it } from "vitest";
import { fromBase64Url, fromHex, toBase64Url, toHex } from "./encoding";

describe("base64url", () => {
  it("agrees with Node for every length up to 64", () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 97 + 13) & 0xff);
      const text = Buffer.from(bytes).toString("base64url");
      expect(toBase64Url(bytes)).toBe(text);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it.each([
    ["padding", "AA=="],
    ["standard alphabet", "+/8"],
    ["whitespace", "AA AA"],
    ["impossible length", "AAAAA"],
    ["nonzero unused bits", "AB"],
  ])("refuses %s", (_name, text) => {
    expect(fromBase64Url(text)).toBeNull();
  });
});

describe("hex", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array([0, 1, 0xab, 0xff]);
    expect(toHex(bytes)).toBe("0001abff");
    expect(fromHex("0001abff")).toEqual(bytes);
  });

  it.each(["0", "AB", "zz"])("refuses %j", (text) => {
    expect(fromHex(text)).toBeNull();
  });
});
