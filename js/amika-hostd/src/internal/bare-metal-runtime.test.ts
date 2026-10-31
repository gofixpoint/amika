/**
 * Cover the bare-metal runtime against a fake amikad: a small Node script
 * that records how it was run and, for `serve`, answers `/healthz` on the
 * address hostd gives it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  BARE_METAL_EXEC_ALLOWLIST,
  allowedCommand,
  assertInside,
  bareMetalRuntime,
  type BareMetalRuntime,
} from "./bare-metal-runtime.js";
import { RuntimeError } from "./machine-runtime.js";

const RESOURCES = {
  vcpus: 8,
  memoryGib: 16,
  diskGib: 460.4,
  os: "linux",
  arch: "x64",
};

/**
 * The fake amikad. Every run appends `{args, env, stdin, cwd}` to
 * `calls.jsonl` beside it. `serve` listens on `AMIKAD_LISTEN` and records
 * its pid in `serve.pid`, unless `crash-once` exists, which it removes
 * before exiting 3.
 */
const FAKE_AMIKAD = `
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dir = __dirname;
const args = process.argv.slice(2);
let stdin = "";
const record = () =>
  fs.appendFileSync(
    path.join(dir, "calls.jsonl"),
    JSON.stringify({ args, env: process.env, stdin, cwd: process.cwd() }) + "\\n",
  );
if (args[0] === "serve") {
  record();
  const crash = path.join(dir, "crash-once");
  if (fs.existsSync(crash)) {
    fs.rmSync(crash);
    process.exit(3);
  }
  const [host, port] = process.env.AMIKAD_LISTEN.split(":");
  http
    .createServer((req, res) => res.end(req.url === "/healthz" ? "ok" : ""))
    .listen(Number(port), host, () =>
      fs.writeFileSync(path.join(dir, "serve.pid"), String(process.pid)),
    );
  process.on("SIGTERM", () => process.exit(0));
} else {
  process.stdin.on("data", (chunk) => (stdin += chunk));
  process.stdin.on("end", () => {
    record();
    process.stdout.write(args[0] === "host-key" ? "ssh-ed25519 AAAA\\n" : "");
  });
}
`;

const opened: BareMetalRuntime[] = [];

afterEach(async () => {
  for (const runtime of opened.splice(0)) await runtime.shutdown();
});

/** A state directory, a fake amikad, and the runtime over them. */
function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "amika-hostd-bare-"));
  const stateDir = path.join(root, "state");
  const bin = path.join(root, "bin");
  mkdirSync(stateDir);
  mkdirSync(bin);
  const amikad = path.join(bin, "amikad");
  writeFileSync(amikad, `#!${process.execPath}\n${FAKE_AMIKAD}`, {
    mode: 0o755,
  });
  const options = {
    rigFile: path.join(stateDir, "bare-metal-rig.json"),
    stateDir,
    amikadStateDir: path.join(stateDir, "amikad"),
    amikad,
    logFile: path.join(stateDir, "log", "amikad.log"),
    resources: () => RESOURCES,
    now: () => new Date("2026-10-30T12:00:00Z"),
    supervisor: {
      readyTimeoutMs: 5_000,
      restartDelayMs: 50,
      maxRestartDelayMs: 200,
    },
  };
  const open = () => {
    const runtime = bareMetalRuntime(options);
    opened.push(runtime);
    return runtime;
  };
  const calls = (): {
    args: string[];
    env: Record<string, string>;
    stdin: string;
    cwd: string;
  }[] => {
    const file = path.join(bin, "calls.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  return { root, stateDir, bin, options, open, runtime: open(), calls };
}

const sh = (command: string) => ["/bin/sh", "-c", command];

async function created(h: ReturnType<typeof harness>) {
  await h.runtime.create({
    name: "rig",
    image: "ignored",
    network: true,
    services: [{ name: "amikad", port: 60999 }],
  });
}

async function healthz(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
}

async function eventually(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error("timed out");
}

function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(RuntimeError);
      return error as RuntimeError;
    },
  );
}

describe("bareMetalRuntime: the one rig", () => {
  it("records a created rig as running, on two loopback ports", async () => {
    const h = harness();
    await created(h);
    const record = JSON.parse(readFileSync(h.options.rigFile, "utf8"));
    expect(record).toMatchObject({
      name: "rig",
      state: "running",
      createdAt: "2026-10-30T12:00:00.000Z",
    });
    expect(record.amikadPort).not.toBe(record.sshdPort);
    expect(await h.runtime.list()).toEqual([
      {
        name: "rig",
        state: "running",
        cpus: 8,
        memoryMb: 16_384,
        storageGb: 460,
        ports: [{ host: record.amikadPort, guest: 60999 }],
      },
    ]);
    expect(await h.runtime.hostPort("rig", 60999)).toBe(record.amikadPort);
    expect(await h.runtime.hostPort("rig", 8080)).toBeNull();
    expect(await h.runtime.hostPort("other", 60999)).toBeNull();
  });

  it("answers a second create with 409, and keeps the first rig", async () => {
    const h = harness();
    await created(h);
    const error = await rejection(
      h.runtime.create({ name: "second", image: "x", network: true }),
    );
    expect(error.status).toBe(409);
    expect(error.reason).toMatch(/already has rig rig/);
    expect((await h.runtime.list()).map((m) => m.name)).toEqual(["rig"]);
  });

  it("survives a restart of the daemon", async () => {
    const h = harness();
    await created(h);
    expect((await h.open().get("rig")).state).toBe("running");
  });

  it("refuses any environment", async () => {
    const h = harness();
    const error = await rejection(
      h.runtime.create({
        name: "rig",
        image: "x",
        network: true,
        env: [{ name: "SECRET", value: "s3cret-value" }],
      }),
    );
    expect(error.status).toBe(400);
    expect(error.reason).not.toContain("s3cret-value");
    expect(await h.runtime.list()).toEqual([]);
  });

  it.each([[{ name: "web", port: 3000 }], [{ name: "amikad", port: 22 }]])(
    "serves only amikad on 60999, refusing %j",
    async (service) => {
      const h = harness();
      const error = await rejection(
        h.runtime.create({
          name: "rig",
          image: "x",
          network: true,
          services: [{ name: "amikad", port: 60999 }, service],
        }),
      );
      expect(error.status).toBe(400);
      await created(h);
      expect(
        (await rejection(h.runtime.checkServices("rig", [service]))).status,
      ).toBe(409);
      await h.runtime.checkServices("rig", [{ name: "amikad", port: 60999 }]);
    },
  );

  it("stops and starts, publishing amikad's port only while running", async () => {
    const h = harness();
    await created(h);
    expect(await h.runtime.stop("rig")).toMatchObject({
      state: "stopped",
      ports: [],
    });
    expect(await h.runtime.hostPort("rig", 60999)).toBeNull();
    expect((await h.runtime.start("rig")).state).toBe("running");
    expect((await rejection(h.runtime.start("nope"))).status).toBe(404);
  });

  it("serves no files", async () => {
    const h = harness();
    await created(h);
    expect(
      (await rejection(h.runtime.readFile("rig", "/etc/passwd"))).status,
    ).toBe(404);
    expect(
      (await rejection(h.runtime.writeFile("rig", "/x", new Uint8Array())))
        .status,
    ).toBe(404);
  });
});

describe("bareMetalRuntime: exec", () => {
  it.each(
    [...BARE_METAL_EXEC_ALLOWLIST].filter(
      ([, allowed]) => allowed.kind === "run",
    ),
  )("runs %j as amikad by path, as this user", async (command, allowed) => {
    const h = harness();
    await created(h);
    const result = await h.runtime.exec("rig", {
      command: sh(command),
      user: "root",
      workdir: "/root",
      env: [
        { name: "HOME", value: "/root" },
        { name: "LD_PRELOAD", value: "/tmp/evil.so" },
      ],
      stdin: "the-token\n",
    });
    expect(result.exitCode).toBe(0);
    const [call] = h.calls();
    expect(call.args).toEqual(allowed.kind === "run" ? allowed.args : []);
    // Only the token and keys reach amikad's stdin.
    expect(call.stdin).toBe(
      allowed.kind === "run" && allowed.stdin ? "the-token\n" : "",
    );
    const record = JSON.parse(readFileSync(h.options.rigFile, "utf8"));
    expect(call.env).toMatchObject({
      AMIKAD_STATE_DIR: h.options.amikadStateDir,
      AMIKAD_LISTEN: `127.0.0.1:${record.amikadPort}`,
      AMIKAD_SSHD_PORT: String(record.sshdPort),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      // Named for a cgo-less amikad, which cannot look up an LDAP account.
      USER: userInfo().username,
      LOGNAME: userInfo().username,
      HOME: userInfo().homedir,
    });
    expect(call.env).not.toHaveProperty("HOME", "/root");
    expect(call.env).not.toHaveProperty("LD_PRELOAD");
    expect(call.cwd).toBe(h.options.amikadStateDir);
  });

  it("passes amikad's output back", async () => {
    const h = harness();
    await created(h);
    expect(
      await h.runtime.exec("rig", { command: sh("amikad host-key show") }),
    ).toMatchObject({ exitCode: 0, stdout: "ssh-ed25519 AAAA\n" });
  });

  it.each([
    ["trailing space", sh("amikad host-key show ")],
    ["leading space", sh(" amikad host-key show")],
    ["doubled space", sh("amikad  host-key show")],
    ["chained command", sh("amikad host-key show; rm -rf ~")],
    ["and-ed command", sh("amikad host-key show && id")],
    ["substitution", sh("amikad host-key show $(id)")],
    ["newline", sh("amikad host-key show\nid")],
    ["other case", sh("AMIKAD HOST-KEY SHOW")],
    ["partial serve", sh("amikad serve --beta-no-relay")],
    ["arbitrary command", sh("id")],
    ["prototype key", sh("constructor")],
    ["another shell", ["/bin/bash", "-c", "amikad host-key show"]],
    ["a relative shell", ["sh", "-c", "amikad host-key show"]],
    ["login shell", ["/bin/sh", "-lc", "amikad host-key show"]],
    ["extra argument", [...sh("amikad host-key show"), "x"]],
    ["too few", ["/bin/sh", "-c"]],
    ["argv form", ["amikad", "host-key", "show"]],
  ])("refuses a %s with 403 and runs nothing", async (_, command) => {
    const h = harness();
    await created(h);
    expect(allowedCommand(command)).toBeUndefined();
    const error = await rejection(h.runtime.exec("rig", { command }));
    expect(error.status).toBe(403);
    expect(h.calls()).toEqual([]);
  });

  it("refuses exec on a rig that is not there", async () => {
    const h = harness();
    expect(
      (
        await rejection(
          h.runtime.exec("rig", { command: sh("amikad host-key show") }),
        )
      ).status,
    ).toBe(404);
  });

  it("says amikad is missing, by name", async () => {
    const h = harness();
    rmSync(h.options.amikad);
    await created(h);
    const error = await rejection(
      h.runtime.exec("rig", { command: sh("amikad host-key show") }),
    );
    expect(error.status).toBe(500);
    expect(error.reason).toMatch(
      /amikad is not installed at .*amika-hostd setup/,
    );
  });
});

describe("bareMetalRuntime: amikad serve", () => {
  it("starts a supervised `amikad serve` and answers once it is up", async () => {
    const h = harness();
    await created(h);
    const { amikadPort } = JSON.parse(readFileSync(h.options.rigFile, "utf8"));
    const result = await h.runtime.exec("rig", {
      command: sh("amikad serve --beta-no-relay --bg"),
      user: "root",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(await healthz(amikadPort)).toBe(true);
    // In the foreground, under hostd: never with `--bg`.
    expect(h.calls().map((call) => call.args)).toEqual([
      ["serve", "--beta-no-relay"],
    ]);
  });

  it("restarts it when it crashes, and again on another serve", async () => {
    const h = harness();
    await created(h);
    const { amikadPort } = JSON.parse(readFileSync(h.options.rigFile, "utf8"));
    await h.runtime.exec("rig", {
      command: sh("amikad serve --beta-no-relay --bg"),
    });
    const pidFile = path.join(h.bin, "serve.pid");
    const first = Number(readFileSync(pidFile, "utf8"));
    process.kill(first, "SIGKILL");
    await eventually(
      async () =>
        Number(readFileSync(pidFile, "utf8")) !== first &&
        (await healthz(amikadPort)),
    );
    const second = Number(readFileSync(pidFile, "utf8"));
    await h.runtime.exec("rig", {
      command: sh("amikad serve --beta-no-relay --bg"),
    });
    expect(Number(readFileSync(pidFile, "utf8"))).not.toBe(second);
  });

  it("reports one that exits as it starts", async () => {
    const h = harness();
    await created(h);
    writeFileSync(path.join(h.bin, "crash-once"), "");
    const result = await h.runtime.exec("rig", {
      command: sh("amikad serve --beta-no-relay --bg"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/exited as it started/);
  });

  it("stops it with the rig, and with the daemon", async () => {
    const h = harness();
    await created(h);
    const { amikadPort } = JSON.parse(readFileSync(h.options.rigFile, "utf8"));
    const serve = sh("amikad serve --beta-no-relay --bg");
    await h.runtime.exec("rig", { command: serve });
    await h.runtime.stop("rig");
    expect(await healthz(amikadPort)).toBe(false);
    await h.runtime.start("rig");
    await h.runtime.exec("rig", { command: serve });
    await h.runtime.shutdown();
    expect(await healthz(amikadPort)).toBe(false);
  });

  it("resumes a running rig's bridge only once it was provisioned", async () => {
    const h = harness();
    await created(h);
    const { amikadPort } = JSON.parse(readFileSync(h.options.rigFile, "utf8"));
    await h.runtime.resume();
    expect(h.calls()).toEqual([]);
    mkdirSync(h.options.amikadStateDir, { recursive: true });
    writeFileSync(path.join(h.options.amikadStateDir, "connect-token"), "t");
    await h.runtime.resume();
    expect(await healthz(amikadPort)).toBe(true);
  });
});

describe("bareMetalRuntime: delete", () => {
  it("removes only amikad's state and the record", async () => {
    const h = harness();
    await created(h);
    await h.runtime.exec("rig", { command: sh("amikad host-key show") });
    writeFileSync(path.join(h.options.amikadStateDir, "connect-token"), "t");
    writeFileSync(path.join(h.stateDir, "services.json"), "{}");
    await h.runtime.remove("rig");
    expect(existsSync(h.options.amikadStateDir)).toBe(false);
    expect(existsSync(h.options.rigFile)).toBe(false);
    expect(existsSync(path.join(h.stateDir, "services.json"))).toBe(true);
    expect(existsSync(h.options.amikad)).toBe(true);
    expect(await h.runtime.list()).toEqual([]);
    // The host takes a new rig now.
    await created(h);
  });

  it("removes a link planted for amikad's state, never its target", async () => {
    const h = harness();
    await created(h);
    const outside = path.join(h.root, "precious");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep"), "x");
    symlinkSync(outside, h.options.amikadStateDir);
    await h.runtime.remove("rig");
    expect(existsSync(h.options.amikadStateDir)).toBe(false);
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("x");
  });

  it("answers 404 for a rig that is not there", async () => {
    const h = harness();
    expect((await rejection(h.runtime.remove("rig"))).status).toBe(404);
  });

  it.each([
    ["the state directory itself", (state: string) => state],
    ["its parent", (state: string) => path.dirname(state)],
    ["a sibling", (state: string) => `${state}-other/amikad`],
    ["a climb out", (state: string) => path.join(state, "..", "amikad")],
  ])("refuses to run with amikad's state at %s", (_, place) => {
    const h = harness();
    expect(() =>
      bareMetalRuntime({
        ...h.options,
        amikadStateDir: place(h.stateDir),
      }),
    ).toThrow(/not inside hostd's state directory/);
  });

  it("accepts a state directory that does not exist yet", () => {
    const root = path.join(tmpdir(), "amika-hostd-absent", String(Date.now()));
    expect(() => assertInside(root, path.join(root, "amikad"))).not.toThrow();
  });

  it("refuses a state directory reached through a link out", () => {
    const h = harness();
    const outside = path.join(h.root, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, path.join(h.stateDir, "via"));
    expect(() =>
      assertInside(h.stateDir, path.join(h.stateDir, "via", "amikad")),
    ).toThrow(/resolves outside/);
  });
});
