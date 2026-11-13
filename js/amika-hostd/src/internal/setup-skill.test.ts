import { describe, expect, it } from "vitest";
import { parseCommand } from "./cli.js";
import { setupSkill } from "./setup-skill.js";

const SKILL = setupSkill({
  configPath: "/home/op/.config/amika-hostd/config.toml",
  logFile: "/home/op/.local/state/amika-hostd/log/amika-hostd.log",
  localUrl: "http://127.0.0.1:3020",
  runtimes: ["smol", "lume", "bare_metal"],
});

/**
 * Each `amika-hostd` command the skill tells an agent to run, as argv: from
 * code lines and inline code, up to a shell redirect, with each `<...>`
 * placeholder filled in.
 */
function skillCommands(): string[][] {
  const found = [
    ...SKILL.matchAll(/^ {4,}(amika-hostd .+)$/gm),
    ...SKILL.matchAll(/`(amika-hostd [^`]+)`/g),
  ].map((match) => match[1]);
  return found.map((command) =>
    command
      .split(/ < /)[0]
      .split(/\s+/)
      .slice(1)
      .flatMap((word) =>
        word === "<runtimes>"
          ? ["--enable", "bare_metal", "--disable", "smol"]
          : word === "<runtime>"
            ? ["smol"]
            : [word.replace(/<[^>]+>/g, "x")],
      ),
  );
}

describe("setupSkill", () => {
  it("names only commands and options the CLI takes", () => {
    const commands = skillCommands();
    expect(commands.length).toBeGreaterThan(5);
    for (const argv of commands) {
      expect(() => parseCommand(argv), argv.join(" ")).not.toThrow();
    }
  });
});
