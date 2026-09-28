import { describe, it, expect } from "vitest";

import { AmikaHTTPError } from "@/errors";

describe("AmikaHTTPError.userMessage", () => {
  it("returns 'code: message' when both are present (new envelope)", () => {
    const body = JSON.stringify({
      code: "INVALID_INPUT",
      message: "name is required",
    });
    const err = new AmikaHTTPError(400, body);
    expect(err.userMessage()).toBe("INVALID_INPUT: name is required");
  });

  it("accepts legacy error_code field", () => {
    const body = JSON.stringify({ error_code: "LEGACY", message: "boom" });
    const err = new AmikaHTTPError(400, body);
    expect(err.userMessage()).toBe("LEGACY: boom");
  });

  it("returns plain message when no code is present", () => {
    const err = new AmikaHTTPError(400, JSON.stringify({ message: "nope" }));
    expect(err.userMessage()).toBe("nope");
  });

  it("falls back to the raw body when body isn't valid JSON", () => {
    const err = new AmikaHTTPError(500, "<html>oops</html>");
    expect(err.userMessage()).toBe("<html>oops</html>");
  });
});
