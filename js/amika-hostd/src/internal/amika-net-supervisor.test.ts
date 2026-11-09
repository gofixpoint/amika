import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  amikaNetArgs,
  amikaNetSupervisor,
  findAmikaNet,
  type AmikaNetSupervisor,
} from "./amika-net-supervisor.js";
import { AMIKA_KEY, writeFakeAmikaNet } from "../testing/iroh.js";

/** RFC 8032's test key 1, standing in for a host key. */
const KEY = Uint8Array.from(Buffer.from(AMIKA_KEY.seed_hex, "hex"));

const supervisors: AmikaNetSupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

function harness(mode?: "exit") {
  const dir = mkdtempSync(path.join(tmpdir(), "hd-net-"));
  const binary = writeFakeAmikaNet(dir);
  const out = path.join(dir, "out");
  mkdirSync(out);
  const errors: string[] = [];
  const supervisor = amikaNetSupervisor({
    binary,
    args: amikaNetArgs(path.join(dir, "control.sock"), undefined),
    key: KEY,
    env: {
      PATH: process.env.PATH,
      FAKE_AMIKA_NET_OUT: out,
      ...(mode ? { FAKE_AMIKA_NET_MODE: mode } : {}),
    },
    logFile: path.join(dir, "amika-net.log"),
    restartDelayMs: 20,
    maxRestartDelayMs: 40,
    stopTimeoutMs: 2_000,
    err: (line) => errors.push(line),
  });
  supervisors.push(supervisor);
  const starts = () =>
    existsSync(path.join(out, "starts"))
      ? readFileSync(path.join(out, "starts"), "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as { args: string[]; key: string; pid: number },
          )
      : [];
  return { supervisor, starts, errors, dir };
}

describe("amikaNetSupervisor", () => {
  it("starts amika-net host with the key on fd 3, not in its arguments", async () => {
    const { supervisor, starts } = harness();
    supervisor.start();
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    const [started] = starts();
    expect(started.key).toBe(AMIKA_KEY.seed_hex);
    expect(started.args).toEqual([
      "host",
      "--control-socket",
      expect.stringMatching(/control\.sock$/),
      "--key-fd",
      "3",
    ]);
    expect(started.args.join(" ")).not.toContain(AMIKA_KEY.seed_hex);
  });

  it("restarts amika-net when it exits, with the key each time", async () => {
    const { supervisor, starts, errors } = harness("exit");
    supervisor.start();
    await vi.waitFor(() => expect(starts().length).toBeGreaterThanOrEqual(3));
    expect(starts().every((s) => s.key === AMIKA_KEY.seed_hex)).toBe(true);
    expect(errors.join("\n")).toContain("amika-net exited (code 3)");
    expect(errors.join("\n")).not.toContain(AMIKA_KEY.seed_hex);
  });

  it("stops amika-net and does not restart it", async () => {
    const { supervisor, starts } = harness();
    supervisor.start();
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    await supervisor.stop();
    const { pid } = starts()[0];
    expect(() => process.kill(pid, 0)).toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(starts()).toHaveLength(1);
    expect(supervisor.wanted).toBe(false);
  });
});

describe("amikaNetArgs", () => {
  it("adds the relay URL when one is set", () => {
    expect(amikaNetArgs("/s/control.sock", "https://relay.test/")).toEqual([
      "host",
      "--control-socket",
      "/s/control.sock",
      "--key-fd",
      "3",
      "--relay-url",
      "https://relay.test/",
    ]);
  });
});

describe("findAmikaNet", () => {
  const executable = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "amika-net");
    writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    return file;
  };

  it("finds it next to hostd first", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hd-find-"));
    const beside = executable(path.join(dir, "hostd"));
    executable(path.join(dir, "bin"));
    expect(
      findAmikaNet({ PATH: path.join(dir, "bin") }, path.join(dir, "hostd")),
    ).toBe(beside);
  });

  it("finds it on PATH", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hd-find-"));
    const onPath = executable(path.join(dir, "bin"));
    expect(
      findAmikaNet({ PATH: path.join(dir, "bin") }, path.join(dir, "hostd")),
    ).toBe(onPath);
  });

  it("finds nothing when it is not installed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hd-find-"));
    expect(findAmikaNet({ PATH: dir }, dir)).toBeUndefined();
  });
});
