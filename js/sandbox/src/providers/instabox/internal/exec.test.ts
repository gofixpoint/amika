import { describe, expect, it } from "vitest";
import { collectExecEvents, execRequestBody } from "./exec";
import { readSse } from "./sse";

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function events(...parts: string[]) {
  const out = [];
  for await (const event of readSse(streamOf(...parts))) out.push(event);
  return out;
}

describe("readSse", () => {
  it("reads events split across chunks and line endings", async () => {
    expect(
      await events(
        'event: stdout\ndata: {"data":"a"}\n',
        "\nevent: std",
        'err\r\ndata: {"data":"b"}\r',
        "\n\r\n: comment\n\n",
        "event: exit\ndata: one\ndata: two",
      ),
    ).toEqual([
      { event: "stdout", data: '{"data":"a"}' },
      { event: "stderr", data: '{"data":"b"}' },
      { event: "exit", data: "one\ntwo" },
    ]);
  });

  it("names an event without an event field `message`", async () => {
    expect(await events("data: x\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });
});

describe("collectExecEvents", () => {
  async function* script(
    ...items: Array<[string, unknown]>
  ): AsyncGenerator<{ event: string; data: string }> {
    for (const [event, data] of items) {
      yield { event, data: JSON.stringify(data) };
    }
  }

  it("keeps the streams apart and sends chunks to the handlers", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await collectExecEvents(
      script(
        ["stdout", { data: "first\n" }],
        ["stderr", { data: "oops\n" }],
        ["stdout", { data: "second\n" }],
        ["exit", { exitCode: 3, stdout: "", stderr: "" }],
      ),
      { onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) },
    );
    expect(result).toEqual({
      exitCode: 3,
      stdout: "first\nsecond\n",
      stderr: "oops\n",
    });
    expect(out).toEqual(["first\n", "second\n"]);
    expect(err).toEqual(["oops\n"]);
  });

  it("throws on an error event", async () => {
    await expect(
      collectExecEvents(
        script(["error", { code: "machine_not_running", message: "stopped" }]),
      ),
    ).rejects.toThrow(/machine_not_running: stopped/);
  });

  it("throws when the stream ends without an exit event", async () => {
    await expect(
      collectExecEvents(script(["stdout", { data: "x" }])),
    ).rejects.toThrow(/without an exit event/);
  });
});

describe("execRequestBody", () => {
  it("runs a shell string with env, cwd, and stdin", () => {
    expect(
      execRequestBody("echo hi", {
        cwd: "/tmp",
        env: { A: "1" },
        input: "data",
      }),
    ).toEqual({
      cmd: "echo hi",
      envs: { A: "1" },
      cwd: "/tmp",
      stdin: "data",
      timeoutSeconds: 600,
    });
  });

  it("runs sudo as argv and passes env inside sudo", () => {
    expect(execRequestBody("id -u", { sudo: true, env: { A: "x y" } })).toEqual(
      {
        argv: ["sudo", "-n", "env", "A=x y", "bash", "-lc", "id -u"],
        timeoutSeconds: 600,
      },
    );
  });

  it("refuses a bad env name and too much input", () => {
    expect(() => execRequestBody("true", { env: { "A=B": "1" } })).toThrow(
      /Invalid environment variable name/,
    );
    expect(() =>
      execRequestBody("true", { input: "x".repeat(1024 * 1024 + 1) }),
    ).toThrow(/1 MiB/);
  });
});
