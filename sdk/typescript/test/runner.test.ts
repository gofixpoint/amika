import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Runner } from "../src/runner.js";
import { AmikaBinaryNotFoundError, AmikaCommandError } from "../src/errors.js";
import { fakeBinaryPath, fakeEnv } from "./helpers.js";

describe("Runner", () => {
  it("runs the binary and captures stdout/stderr", async () => {
    const runner = new Runner({ binary: fakeBinaryPath });
    const result = await runner.run(["hello", "world"], {
      env: fakeEnv({ stdout: "out!", stderr: "err!" }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "out!");
    assert.equal(result.stderr, "err!");
    assert.deepEqual(result.args, ["hello", "world"]);
  });

  it("forwards args to the binary", async () => {
    const runner = new Runner({ binary: fakeBinaryPath });
    const result = await runner.run(["sandbox", "list", "--local"], {
      env: fakeEnv({ echoArgs: true }),
    });
    const echoed = JSON.parse(result.stdout) as { args: string[] };
    assert.deepEqual(echoed.args, ["sandbox", "list", "--local"]);
  });

  it("writes stdin to the child", async () => {
    const runner = new Runner({ binary: fakeBinaryPath });
    const result = await runner.run(["agent-send", "box"], {
      env: fakeEnv({ echoArgs: true, readStdin: true }),
      stdin: "hello from sdk\n",
    });
    const echoed = JSON.parse(result.stdout) as { stdin: string };
    assert.equal(echoed.stdin, "hello from sdk\n");
  });

  it("rejects with AmikaCommandError on non-zero exit", async () => {
    const runner = new Runner({ binary: fakeBinaryPath });
    await assert.rejects(
      runner.run(["sandbox", "delete", "missing"], {
        env: fakeEnv({ exitCode: 2, stderr: "not found" }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof AmikaCommandError);
        assert.equal(err.exitCode, 2);
        assert.equal(err.stderr, "not found");
        assert.deepEqual(err.args, ["sandbox", "delete", "missing"]);
        return true;
      },
    );
  });

  it("rejects with AmikaBinaryNotFoundError when the binary is missing", async () => {
    const runner = new Runner({ binary: "/definitely/does/not/exist/amika-xyz" });
    await assert.rejects(runner.run(["--version"]), (err: unknown) => {
      assert.ok(err instanceof AmikaBinaryNotFoundError);
      return true;
    });
  });

  it("times out and rejects", async () => {
    const runner = new Runner({ binary: fakeBinaryPath });
    await assert.rejects(
      runner.run(["--version"], {
        env: fakeEnv({ sleepMs: 500 }),
        timeoutMs: 50,
      }),
      (err: unknown) => {
        assert.ok(err instanceof AmikaCommandError);
        assert.match(err.message, /timed out/);
        return true;
      },
    );
  });

  it("aborts when the signal fires", async () => {
    const runner = new Runner({ binary: fakeBinaryPath });
    const controller = new AbortController();
    const promise = runner.run(["--version"], {
      env: fakeEnv({ sleepMs: 500 }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof AmikaCommandError);
      assert.match(err.message, /aborted/);
      return true;
    });
  });
});
