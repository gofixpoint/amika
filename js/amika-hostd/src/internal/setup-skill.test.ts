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
    // The `amika` CLI's commands carry that CLI's options, not amika-hostd's.
    const hostdOnly = skill
      .replace(/^ +amika .*$/gm, "")
      .replace(/`amika [^`]*`/g, "");
    for (const option of hostdOnly.match(/(?<![-\w])--[a-z][a-z-]*/g) ?? []) {
      if (option === "--url") continue; // cloudflared's
      expect(USAGE).toContain(option);
    }
  });

  it("creates the API key with the amika CLI into a file, never printing it", () => {
    // The key goes from `amika auth api-key create` into a file, from the
    // file into setup's stdin, and the file is removed.
    expect(skill).toContain(
      "      amika auth api-key create --name <name>-hostd --out <dir>/api-key",
    );
    expect(skill).toContain(
      "    amika-hostd setup --non-interactive --hostname <name> < <dir>/api-key",
    );
    expect(skill).toContain("    rm -rf <dir>");
    expect(skill).toContain("    mktemp -d");
    expect(skill).toContain("`amika auth status`");
    // Without a logged-in CLI, the operator creates the key in the web app.
    expect(skill).toContain("https://app.amika.dev/settings/api-keys");
  });

  it("makes a key only when setup has none", () => {
    // The probe runs setup with empty input, and the skill quotes the exact
    // error setup gives when it needs a key.
    expect(skill).toContain(
      "    amika-hostd setup --non-interactive --hostname <name> < /dev/null",
    );
    const cli = readFileSync(path.join(import.meta.dirname, "cli.ts"), "utf8");
    const needsKey =
      "pipe the Amika API key into `amika-hostd setup --non-interactive`";
    expect(cli).toContain(needsKey);
    expect(skill.replace(/\s+/g, " ")).toContain(needsKey);
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
    expect(skill).toContain("`ngrok http http://127.0.0.1:4100`");
    expect(skill).toContain("`cloudflared tunnel --url http://127.0.0.1:4100`");
    expect(skill).not.toContain("3020");
  });

  it("tunnels to a daemon bound to another address, not localhost", () => {
    const bound = setupSkill({
      configPath: "/c.toml",
      logFile: "/l.log",
      localUrl: "http://192.168.1.20:3020",
    });
    expect(bound).toContain("`ngrok http http://192.168.1.20:3020`");
    expect(bound).toContain(
      "`cloudflared tunnel --url http://192.168.1.20:3020`",
    );
  });
});
