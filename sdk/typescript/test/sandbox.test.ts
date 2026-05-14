import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AmikaClient } from "../src/client.js";
import { SandboxCommands } from "../src/commands/sandbox.js";
import { Runner } from "../src/runner.js";
import { fakeBinaryPath, fakeEnv } from "./helpers.js";

describe("SandboxCommands.buildCreateArgs", () => {
  const runner = new Runner({ binary: fakeBinaryPath });
  const sandbox = new SandboxCommands(runner);

  it("builds minimal args when no options are passed", () => {
    assert.deepEqual(sandbox.buildCreateArgs(), ["sandbox", "create"]);
  });

  it("includes name, preset, and yes", () => {
    const args = sandbox.buildCreateArgs({ name: "dev", preset: "coder", yes: true });
    assert.deepEqual(args, ["sandbox", "create", "--name", "dev", "--preset", "coder", "--yes"]);
  });

  it("includes scope flag", () => {
    const args = sandbox.buildCreateArgs({ scope: "remote", name: "r" });
    assert.deepEqual(args, ["sandbox", "create", "--remote", "--name", "r"]);
  });

  it("repeats --mount, --volume, --port, --secret", () => {
    const args = sandbox.buildCreateArgs({
      name: "dev",
      mount: ["./a:/a:ro", "./b:/b"],
      volume: ["vol1:/v:rw"],
      port: ["8080:8080", "3000:3000"],
      secret: ["env:FOO=BAR"],
    });
    assert.deepEqual(args, [
      "sandbox",
      "create",
      "--name",
      "dev",
      "--mount",
      "./a:/a:ro",
      "--mount",
      "./b:/b",
      "--volume",
      "vol1:/v:rw",
      "--port",
      "8080:8080",
      "--port",
      "3000:3000",
      "--secret",
      "env:FOO=BAR",
    ]);
  });

  it("converts env record into repeated --env flags", () => {
    const args = sandbox.buildCreateArgs({
      name: "dev",
      env: { FOO: "bar", BAZ: "qux" },
    });
    assert.ok(args.includes("--env"));
    const envIndices = args.reduce<number[]>((acc, v, i) => (v === "--env" ? [...acc, i] : acc), []);
    assert.equal(envIndices.length, 2);
    const values = envIndices.map((i) => args[i + 1]).sort();
    assert.deepEqual(values, ["BAZ=qux", "FOO=bar"]);
  });

  it("supports --git with a path", () => {
    const args = sandbox.buildCreateArgs({ name: "dev", git: "./src" });
    assert.deepEqual(args, ["sandbox", "create", "--name", "dev", "--git", "./src"]);
  });

  it("supports --git without a path", () => {
    const args = sandbox.buildCreateArgs({ name: "dev", git: true });
    assert.deepEqual(args, ["sandbox", "create", "--name", "dev", "--git"]);
  });
});

describe("SandboxCommands.buildDeleteArgs", () => {
  const runner = new Runner({ binary: fakeBinaryPath });
  const sandbox = new SandboxCommands(runner);

  it("places names after flags", () => {
    const args = sandbox.buildDeleteArgs({
      names: ["one", "two"],
      deleteVolumes: true,
    });
    assert.deepEqual(args, ["sandbox", "delete", "--delete-volumes", "one", "two"]);
  });
});

describe("SandboxCommands.buildAgentSendArgs", () => {
  const runner = new Runner({ binary: fakeBinaryPath });
  const sandbox = new SandboxCommands(runner);

  it("includes positional sandbox name and message", () => {
    const args = sandbox.buildAgentSendArgs({
      name: "box",
      message: "do the thing",
      agent: "claude",
      noWait: true,
    });
    assert.deepEqual(args, [
      "sandbox",
      "agent-send",
      "--no-wait",
      "--agent",
      "claude",
      "box",
      "do the thing",
    ]);
  });

  it("omits the message when not provided (caller pipes via stdin)", () => {
    const args = sandbox.buildAgentSendArgs({ name: "box" });
    assert.deepEqual(args, ["sandbox", "agent-send", "box"]);
  });
});

describe("AmikaClient integration with fake binary", () => {
  it("invokes amika sandbox list and returns stdout", async () => {
    const client = new AmikaClient({ binary: fakeBinaryPath });
    const result = await client.sandbox.list(
      { scope: "local" },
      { env: fakeEnv({ stdout: "NAME STATE\n", echoArgs: false }) },
    );
    assert.equal(result.stdout, "NAME STATE\n");
  });

  it("client.version trims output", async () => {
    const client = new AmikaClient({ binary: fakeBinaryPath });
    const version = await client.version({ env: fakeEnv({ stdout: "amika 1.2.3\n" }) });
    assert.equal(version, "amika 1.2.3");
  });

  it("raw passes through arbitrary args", async () => {
    const client = new AmikaClient({ binary: fakeBinaryPath });
    const result = await client.raw(["materialize", "--script", "x"], {
      env: fakeEnv({ echoArgs: true }),
    });
    const echoed = JSON.parse(result.stdout) as { args: string[] };
    assert.deepEqual(echoed.args, ["materialize", "--script", "x"]);
  });
});
