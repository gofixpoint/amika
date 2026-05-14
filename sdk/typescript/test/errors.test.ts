import { describe, it, expect } from "vitest";

import { AmikaHTTPError, extractAgentAuthError } from "@/errors";

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

describe("extractAgentAuthError", () => {
  it("returns the agent result when an authentication_error is reported", () => {
    const detailsObj = {
      is_error: true,
      result: "anthropic returned authentication_error: invalid x-api-key",
    };
    const envelope = {
      error: "agent run failed",
      details: JSON.stringify(detailsObj),
    };
    const err = new AmikaHTTPError(500, JSON.stringify(envelope));
    expect(extractAgentAuthError(err)).toMatch(/authentication_error/);
  });

  it("returns '' when the agent error isn't auth-related", () => {
    const detailsObj = { is_error: true, result: "rate limited" };
    const envelope = {
      error: "agent run failed",
      details: JSON.stringify(detailsObj),
    };
    const err = new AmikaHTTPError(500, JSON.stringify(envelope));
    expect(extractAgentAuthError(err)).toBe("");
  });

  it("returns '' for non-HTTP errors", () => {
    expect(extractAgentAuthError(new Error("network down"))).toBe("");
  });

  it("returns '' when the body isn't JSON", () => {
    expect(extractAgentAuthError(new AmikaHTTPError(500, "plain text"))).toBe(
      "",
    );
  });
});
