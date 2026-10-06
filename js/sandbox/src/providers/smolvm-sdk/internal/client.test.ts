import { describe, expect, it } from "vitest";
import { SmolError } from "smolmachines";
import { smolErrorCode } from "./client";

describe("smolErrorCode", () => {
  it.each([
    ["an SDK error", new SmolError("NOT_FOUND", "VM not found"), "NOT_FOUND"],
    [
      "an error carrying a code",
      Object.assign(new Error("x"), { code: "CONFLICT" }),
      "CONFLICT",
    ],
    ["an error without one", new Error("x"), ""],
    ["a non-string code", Object.assign(new Error("x"), { code: 404 }), ""],
    ["a string", "[NOT_FOUND] gone", ""],
    ["null", null, ""],
    ["undefined", undefined, ""],
  ])("reads %s", (_label, error, code) => {
    expect(smolErrorCode(error)).toBe(code);
  });
});
