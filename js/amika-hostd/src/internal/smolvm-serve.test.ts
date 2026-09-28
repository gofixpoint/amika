/** Cover starting and stopping the managed `smolvm serve` process. */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonError, daemonPaths, type Spawn } from "./daemon.js";
import {
  findSmolvm,
  smolvmListenAddress,
  startSmolvm,
  type SmolvmDeps,
} from "./smolvm-serve.js";

function paths() {
  const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
  return daemonPaths({ XDG_STATE_HOME: dir });
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: vi.fn(),
    unref: vi.fn(),
  });
  return child as typeof child & ChildProcess;
}

/** A fetch that answers `/health` with each status in turn (or refuses). */
function health(...statuses: (number | undefined)[]) {
  return vi.fn(async () => {
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    if (status === undefined) throw new TypeError("fetch failed");
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

function fakeDeps(child = fakeChild(), overrides: SmolvmDeps = {}) {
  return {
    spawn: vi.fn<Spawn>(() => child),
    fetch: health(undefined, 200),
    findSmolvm: () => "/opt/smolvm/smolvm",
    isSmolvmRunning: () => false,
    pollMs: 1,
    ...overrides,
  } satisfies SmolvmDeps;
}

describe("smolvmListenAddress", () => {
  it.each([
    [undefined, "http://127.0.0.1:8080", "127.0.0.1:8080"],
    ["http://127.0.0.1:9000/", "http://127.0.0.1:9000", "127.0.0.1:9000"],
    ["http://[::1]:9000", "http://[::1]:9000", "[::1]:9000"],
    ["http://10.0.0.5", "http://10.0.0.5", "10.0.0.5:80"],
  ])("listens where %s points", (url, origin, listen) => {
    expect(smolvmListenAddress(url)).toEqual({ origin, listen });
  });

  it.each([
    "https://127.0.0.1:8080",
    "http://127.0.0.1:8080/smol",
    "http://user:pw@127.0.0.1:8080",
    "unix:///run/smolvm.sock",
    // smolvm's --listen takes only an IP address.
    "http://localhost:8080",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => smolvmListenAddress(url)).toThrow(DaemonError);
  });
});

describe("findSmolvm", () => {
  function executable(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return file;
  }

  it("prefers PATH, then the installer's locations", () => {
    const home = mkdtempSync(path.join(tmpdir(), "home-"));
    const bin = path.join(home, "bin");
    expect(findSmolvm({ HOME: home, PATH: bin })).toBeUndefined();
    const linked = executable(path.join(home, ".local", "bin", "smolvm"));
    expect(findSmolvm({ HOME: home, PATH: bin })).toBe(linked);
    const installed = executable(path.join(home, ".smolvm", "smolvm"));
    expect(findSmolvm({ HOME: home, PATH: bin })).toBe(installed);
    const onPath = executable(path.join(bin, "smolvm"));
    expect(findSmolvm({ HOME: home, PATH: bin })).toBe(onPath);
  });

  it("skips relative PATH entries and files it cannot run", () => {
    const home = mkdtempSync(path.join(tmpdir(), "home-"));
    writeFileSync(path.join(home, "smolvm"), "");
    expect(
      findSmolvm({ HOME: home, PATH: [".", home].join(path.delimiter) }),
    ).toBeUndefined();
  });
});

describe("startSmolvm", () => {
  it("spawns smolvm detached with drain on, and waits until it serves", async () => {
    const files = paths();
    const deps = fakeDeps();
    const smolvm = await startSmolvm(
      "http://127.0.0.1:9000",
      files,
      { KEEP: "1" },
      deps,
    );
    expect(smolvm.pid).toBe(4242);
    expect(deps.spawn).toHaveBeenCalledWith(
      "/opt/smolvm/smolvm",
      ["serve", "start", "--listen", "127.0.0.1:9000"],
      expect.objectContaining({
        detached: true,
        env: { KEEP: "1", SMOLVM_DRAIN_ON_SHUTDOWN: "1" },
      }),
    );
    expect(readFileSync(files.smolvmPidFile, "utf8")).toBe("4242\n");
  });

  it("refuses when something already answers at the URL", async () => {
    const deps = fakeDeps(fakeChild(), { fetch: health(404) });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      "something is already listening at http://127.0.0.1:8080",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("refuses while a smolvm from an earlier run is still up", async () => {
    const files = paths();
    mkdirSync(path.dirname(files.smolvmPidFile), { recursive: true });
    writeFileSync(files.smolvmPidFile, "31337\n");
    const deps = fakeDeps(fakeChild(), { isSmolvmRunning: () => true });
    await expect(startSmolvm(undefined, files, {}, deps)).rejects.toThrow(
      "still running (pid 31337); stop it with `amika-hostd down`",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("says how to install a missing smolvm", async () => {
    const deps = fakeDeps(fakeChild(), { findSmolvm: () => undefined });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      /smolvm not found .*install-amika-hostd\.sh/,
    );
  });

  it("reports an exit during startup with the log location", async () => {
    const files = paths();
    const child = fakeChild();
    const deps = fakeDeps(child, { fetch: health(undefined) });
    const started = startSmolvm(undefined, files, {}, deps);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
    child.emit("exit", 2, null);
    await expect(started).rejects.toThrow(
      `smolvm exited with code 2 during startup; see ${files.smolvmLogFile}`,
    );
    expect(existsSync(files.smolvmPidFile)).toBe(false);
  });

  it("stops a smolvm that never starts serving", async () => {
    const child = fakeChild();
    const deps = fakeDeps(child, {
      fetch: health(undefined),
      readyTimeoutMs: 20,
      stopTimeoutMs: 20,
    });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      "smolvm did not start serving at http://127.0.0.1:8080 within 0.02s",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops a smolvm whose pidfile cannot be written", async () => {
    const files = paths();
    // A directory where the pidfile goes makes the write fail.
    mkdirSync(files.smolvmPidFile, { recursive: true });
    const child = fakeChild();
    await expect(
      startSmolvm(undefined, files, {}, fakeDeps(child)),
    ).rejects.toThrow(`cannot write ${files.smolvmPidFile}: EISDIR`);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops waiting to serve once the signal aborts", async () => {
    const child = fakeChild();
    const aborted = new AbortController();
    aborted.abort();
    const deps = fakeDeps(child, {
      fetch: health(undefined),
      signal: aborted.signal,
    });
    const smolvm = await startSmolvm(undefined, paths(), {}, deps);
    expect(smolvm.running).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("gives up waiting on a slow stop without killing smolvm", async () => {
    const child = fakeChild();
    const deps = fakeDeps(child, { stopTimeoutMs: 20 });
    const smolvm = await startSmolvm(undefined, paths(), {}, deps);
    expect(await smolvm.stop()).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    // The daemon can exit while smolvm finishes stopping its machines.
    expect(child.unref).toHaveBeenCalled();
  });

  it("runs, serves and stops a real process", async () => {
    const files = paths();
    const dir = path.dirname(files.smolvmPidFile);
    const port = await freePort();
    const fake = path.join(dir, "smolvm");
    mkdirSync(dir, { recursive: true });
    // Stands in for `smolvm serve start --listen <host:port>`.
    writeFileSync(
      fake,
      `#!${process.execPath}
const [host, port] = process.argv[process.argv.indexOf("--listen") + 1].split(":");
console.log("drain=" + process.env.SMOLVM_DRAIN_ON_SHUTDOWN);
const server = require("node:http")
  .createServer((_req, res) => res.end("ok"))
  .listen(Number(port), host);
process.on("SIGTERM", () => {
  console.log("stopping machines");
  server.close(() => process.exit(0));
});
`,
    );
    chmodSync(fake, 0o755);
    const smolvm = await startSmolvm(
      `http://127.0.0.1:${port}`,
      files,
      {},
      { findSmolvm: () => fake },
    );
    expect(readFileSync(files.smolvmPidFile, "utf8")).toBe(`${smolvm.pid}\n`);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await response.text()).toBe("ok");
    expect(await smolvm.stop()).toBe(true);
    expect(await smolvm.exited).toBe("exited with code 0");
    await vi.waitFor(() => expect(existsSync(files.smolvmPidFile)).toBe(false));
    expect(readFileSync(files.smolvmLogFile, "utf8")).toBe(
      "drain=1\nstopping machines\n",
    );
  }, 20_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
