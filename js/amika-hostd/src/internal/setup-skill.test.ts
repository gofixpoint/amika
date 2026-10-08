/** Keep the agent instructions `setup --skill` prints in step with the CLI. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE } from "./cli.js";
import { ENV_NAMES } from "./config.js";
import { setupSkill } from "./setup-skill.js";

const skill = setupSkill({
  configPath: "/home/op/.config/amika-hostd/config.toml",
  logFile: "/home/op/.local/state/amika-hostd/log/amika-hostd.log",
  localUrl: "http://127.0.0.1:4100",
});

describe("setupSkill", () => {
  it("is a SKILL.md document an agent can save", () => {
    expect(skill).toMatch(
      /^---\nname: amika-hostd-setup\ndescription: .+\n---\n/,
    );
  });

  it("names this host's config and log files", () => {
    expect(skill).toContain("    /home/op/.config/amika-hostd/config.toml");
    expect(skill).toContain(
      "/home/op/.local/state/amika-hostd/log/amika-hostd.log",
    );
  });

  it("only runs commands and options amika-hostd has", () => {
    const commands = new Set(
      [...USAGE.matchAll(/^ {2}([a-z-]+)\s/gm)].map((match) => match[1]),
    );
    // In code only: inline backticks, or an indented command line.
    const used = [...skill.matchAll(/(?:`|^ {4})amika-hostd ([a-z-]+)/gm)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(0);
    for (const command of used) expect(commands).toContain(command);
    for (const option of skill.match(/(?<![-\w])--[a-z][a-z-]*/g) ?? []) {
      if (option === "--url") continue; // cloudflared's
      expect(USAGE).toContain(option);
    }
  });

  it("names only variables the config reads", () => {
    for (const name of skill.match(/AMIKA_[A-Z_]+/g) ?? []) {
      expect(Object.values(ENV_NAMES).flat()).toContain(name);
    }
  });

  it("names every error that means there is no keychain to use", () => {
    const credentials = readFileSync(
      path.join(import.meta.dirname, "credentials.ts"),
      "utf8",
    );
    for (const phrase of [
      "No keychain on this machine",
      "nowhere to keep its secrets",
      "secret-tool is not installed",
    ]) {
      expect(credentials).toContain(phrase);
      expect(skill.replace(/\s+/g, " ")).toContain(phrase);
    }
  });

  it("tunnels to the daemon's own address", () => {
    expect(skill).toContain("`ngrok http 4100`");
    expect(skill).toContain("`cloudflared tunnel --url http://127.0.0.1:4100`");
    expect(skill).not.toContain("3020");
  });
});
