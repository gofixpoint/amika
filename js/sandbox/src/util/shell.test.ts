import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell";

describe("shellQuote", () => {
  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("quotes an empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("leaves spaces and double quotes literal inside the single quotes", () => {
    expect(shellQuote('a b "c"')).toBe(`'a b "c"'`);
  });

  it("does not expand shell metacharacters", () => {
    expect(shellQuote("$(rm -rf /); `whoami` && x")).toBe(
      "'$(rm -rf /); `whoami` && x'",
    );
  });

  it("escapes a single quote using the '\"'\"' idiom", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it("escapes every single quote in a value", () => {
    expect(shellQuote("'a'")).toBe(`''"'"'a'"'"''`);
  });

  it("round-trips verbatim through a real shell (sh -c printf)", () => {
    const values = [
      "hello",
      "it's",
      "a b c",
      "$(id)",
      "`whoami`",
      '"quoted"',
      "back\\slash",
      "a'b'c",
      "; rm -rf / #",
    ];
    for (const value of values) {
      // The quoted token must reach `printf` as a single argument equal to the
      // original value — no expansion, splitting, or metacharacter effect.
      const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], {
        encoding: "utf8",
      });
      expect(out).toBe(value);
    }
  });
});
