import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import {
  askYesNo,
  chooseRuntimes,
  RUNTIME_QUESTIONS,
} from "./runtime-choice.js";
import type { RuntimeName } from "./runtimes.js";

const MAC: RuntimeName[] = ["smol", "lume", "bare_metal"];
const LINUX: RuntimeName[] = ["smol", "bare_metal"];
const on = (...names: RuntimeName[]) => new Set(names);

describe("chooseRuntimes", () => {
  it("asks about each runtime this machine can run, offering what is on", async () => {
    const ask = vi.fn(async (_question: string, current: boolean) => current);
    expect(await chooseRuntimes(MAC, on("smol"), ask)).toEqual({
      enable: [],
      disable: [],
    });
    expect(ask.mock.calls).toEqual([
      [RUNTIME_QUESTIONS.smol, true],
      [RUNTIME_QUESTIONS.lume, false],
      [RUNTIME_QUESTIONS.bare_metal, false],
    ]);
  });

  it("never asks about lume where it cannot run", async () => {
    const ask = vi.fn(async () => true);
    expect(await chooseRuntimes(LINUX, on("smol"), ask)).toEqual({
      enable: ["bare_metal"],
      disable: [],
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("turns on and off what the answers say", async () => {
    const answers: Record<string, boolean> = {
      [RUNTIME_QUESTIONS.smol]: false,
      [RUNTIME_QUESTIONS.lume]: true,
      [RUNTIME_QUESTIONS.bare_metal]: true,
    };
    expect(
      await chooseRuntimes(MAC, on("smol"), async (q) => answers[q]),
    ).toEqual({ enable: ["lume", "bare_metal"], disable: ["smol"] });
  });

  it("takes given runtimes without asking about them", async () => {
    const ask = vi.fn(async (_q: string, current: boolean) => current);
    expect(
      await chooseRuntimes(MAC, on("smol"), ask, {
        enable: ["lume"],
        disable: [],
      }),
    ).toEqual({ enable: ["lume"], disable: [] });
    expect(ask.mock.calls.map(([q]) => q)).toEqual([
      RUNTIME_QUESTIONS.smol,
      RUNTIME_QUESTIONS.bare_metal,
    ]);
  });

  it("keeps what is on with nothing to ask", async () => {
    expect(await chooseRuntimes(MAC, on("smol", "lume"), undefined)).toEqual({
      enable: [],
      disable: [],
    });
  });

  it("refuses a runtime this machine cannot run", async () => {
    await expect(
      chooseRuntimes(LINUX, on("smol"), undefined, {
        enable: ["lume"],
        disable: [],
      }),
    ).rejects.toThrow(
      "This machine cannot run lume; it can run smol, bare_metal",
    );
  });

  it("refuses leaving no runtime on", async () => {
    await expect(
      chooseRuntimes(LINUX, on("smol"), async () => false),
    ).rejects.toThrow(ConfigError);
  });
});

describe("askYesNo", () => {
  it("shows the current answer, which an empty reply keeps", async () => {
    const prompt = vi.fn(async () => "");
    expect(await askYesNo(prompt)("Lume?", false)).toBe(false);
    expect(await askYesNo(prompt)("Smol?", true)).toBe(true);
    expect(prompt.mock.calls).toEqual([["Lume? [y/N] "], ["Smol? [Y/n] "]]);
  });

  it("keeps the current answer at end of input", async () => {
    expect(await askYesNo(async () => undefined)("Smol?", true)).toBe(true);
  });

  it("asks again until it gets a yes or a no", async () => {
    const replies = ["maybe", "YES"];
    const prompt = vi.fn(async () => replies.shift());
    expect(await askYesNo(prompt)("Lume?", false)).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
