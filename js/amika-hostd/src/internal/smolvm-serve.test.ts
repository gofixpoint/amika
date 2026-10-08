/** Cover starting and stopping the managed `smolvm serve` process. */
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  appendFileSync,
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
  isOlderVersion,
  isTcpPortInUse,
  smolvmListenAddress,
  smolvmVersion,
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

/** A fetch answering each URL with `statusOf(url)` (undefined refuses). */
function route(statusOf: (url: string) => number | undefined) {
  return vi.fn(async (url: string | URL | Request) => {
    const status = statusOf(String(url));
    if (status === undefined) throw new TypeError("fetch failed");
    return new Response(null, { status });
  }) as unknown as typeof fetch;
}

/** A dev server on 23020 that answers `/health` but is not smolvm. */
const devServerOn23020 = route((url) =>
  url.startsWith("http://127.0.0.1:23020/")
    ? url.endsWith("/health")
      ? 200
      : 404
    : 200,
);

/** Every port but 8080, where smolvm's docs run it by hand, is taken. */
const allButUsual = async (_host: string, port: number) => port !== 8080;

/** `startSmolvm`, failing the test if it resolves without a smolvm. */
async function mustStart(...args: Parameters<typeof startSmolvm>) {
  const smolvm = await startSmolvm(...args);
  if (smolvm === undefined) throw new Error("smolvm was not started");
  return smolvm;
}

function fakeDeps(child = fakeChild(), overrides: SmolvmDeps = {}) {
  return {
    spawn: vi.fn<Spawn>(() => child),
    fetch: health(undefined, 200),
    isPortInUse: vi.fn(async () => false),
    findSmolvm: () => "/opt/smolvm/smolvm",
    isSmolvmRunning: () => false,
    pollMs: 1,
    bindSettleMs: 1,
    ...overrides,
  } satisfies SmolvmDeps;
}

describe("smolvmListenAddress", () => {
  it.each([
    [undefined, "http://127.0.0.1:23020", "127.0.0.1:23020"],
    ["http://127.0.0.1:9000/", "http://127.0.0.1:9000", "127.0.0.1:9000"],
    ["http://[::1]:9000", "http://[::1]:9000", "[::1]:9000"],
    ["http://127.0.0.2", "http://127.0.0.2", "127.0.0.2:80"],
  ])("listens where %s points", (url, origin, listen) => {
    expect(smolvmListenAddress(url)).toMatchObject({ origin, listen });
  });

  it.each([
    "https://127.0.0.1:8080",
    "http://127.0.0.1:8080/smol",
    "http://user:pw@127.0.0.1:8080",
    "unix:///run/smolvm.sock",
    // smolvm's --listen takes only an IP address.
    "http://localhost:8080",
    // smolvm's API has no authentication, so it stays on loopback.
    "http://0.0.0.0:8080",
    "http://10.0.0.5:8080",
    "http://[::]:8080",
    "http://[fe80::1]:8080",
    "http://127.0.0.1:0",
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
    const smolvm = await mustStart(
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
        env: { KEEP: "1", SMOLVM_DRAIN_ON_SHUTDOWN: "1", NO_COLOR: "1" },
      }),
    );
    expect(readFileSync(files.smolvmPidFile, "utf8")).toBe("4242\n");
    expect(readFileSync(files.smolvmUrlFile, "utf8")).toBe(
      "http://127.0.0.1:9000\n",
    );
    expect(smolvm.apiUrl).toBe("http://127.0.0.1:9000");
  });

  it("refuses when another program holds SMOL_API_URL's port", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(allButUsual),
    });
    await expect(
      startSmolvm("http://127.0.0.1:9000", paths(), {}, deps),
    ).rejects.toThrow(
      "another program is already listening at http://127.0.0.1:9000 (SMOL_API_URL)",
    );
    expect(deps.isPortInUse).toHaveBeenCalledWith("127.0.0.1", 9000);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("moves past taken ports when SMOL_API_URL is unset", async () => {
    const files = paths();
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(
        async (_host: string, port: number) => port >= 23020 && port < 23022,
      ),
      // Whatever holds 23020 and 23021 is not a smolvm.
      fetch: health(404, 404, 200),
    });
    const smolvm = await mustStart(undefined, files, {}, deps);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(deps.spawn).toHaveBeenCalledWith(
      "/opt/smolvm/smolvm",
      ["serve", "start", "--listen", "127.0.0.1:23022"],
      expect.anything(),
    );
    expect(smolvm.apiUrl).toBe("http://127.0.0.1:23022");
    expect(readFileSync(files.smolvmUrlFile, "utf8")).toBe(
      "http://127.0.0.1:23022\n",
    );
  });

  it("refuses to start beside a smolvm it did not start", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(allButUsual),
      fetch: health(200),
    });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      "a smolvm that amika-hostd did not start is already serving at http://127.0.0.1:23020",
    );
    // 8080, then 23020.
    expect(deps.isPortInUse).toHaveBeenCalledTimes(2);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("refuses to start beside a smolvm run by hand on 8080", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(async (_host: string, port: number) => port === 8080),
      fetch: health(200),
    });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      "a smolvm that amika-hostd did not start is already serving at http://127.0.0.1:8080",
    );
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("starts as usual when 8080 holds something other than smolvm", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(async (_host: string, port: number) => port === 8080),
      // Cursor, say: it answers no HTTP at all.
      fetch: health(undefined, 200),
    });
    const smolvm = await mustStart(undefined, paths(), {}, deps);
    expect(smolvm.apiUrl).toBe("http://127.0.0.1:23020");
  });

  it("refuses a smolvm it did not start at SMOL_API_URL too", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(allButUsual),
      fetch: health(200),
    });
    await expect(
      startSmolvm("http://127.0.0.1:9000", paths(), {}, deps),
    ).rejects.toThrow(
      "a smolvm that amika-hostd did not start is already serving at http://127.0.0.1:9000",
    );
  });

  it("moves past a server that answers /health but is not smolvm", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(async (_host: string, port: number) => port === 23020),
      fetch: devServerOn23020,
    });
    const smolvm = await mustStart(undefined, paths(), {}, deps);
    expect(smolvm.apiUrl).toBe("http://127.0.0.1:23021");
  });

  it("clears files a dead smolvm left behind, even if startup fails", async () => {
    const files = paths();
    mkdirSync(path.dirname(files.smolvmPidFile), { recursive: true });
    // Far above any real pid, so certainly not running.
    writeFileSync(files.smolvmPidFile, "999999999\n");
    writeFileSync(files.smolvmUrlFile, "http://127.0.0.1:23020\n");
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(async () => true),
      fetch: health(404),
    });
    await expect(startSmolvm(undefined, files, {}, deps)).rejects.toThrow(
      "are all in use",
    );
    expect(existsSync(files.smolvmPidFile)).toBe(false);
    expect(existsSync(files.smolvmUrlFile)).toBe(false);
  });

  it("keeps the files of a live process it cannot confirm", async () => {
    const files = paths();
    mkdirSync(path.dirname(files.smolvmPidFile), { recursive: true });
    writeFileSync(files.smolvmPidFile, `${process.pid}\n`);
    writeFileSync(files.smolvmUrlFile, "http://127.0.0.1:23020\n");
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(async () => true),
      fetch: health(404),
    });
    await expect(startSmolvm(undefined, files, {}, deps)).rejects.toThrow(
      "are all in use",
    );
    expect(readFileSync(files.smolvmPidFile, "utf8")).toBe(`${process.pid}\n`);
    expect(existsSync(files.smolvmUrlFile)).toBe(true);
  });

  it("gives up once every port it tries is taken", async () => {
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(allButUsual),
      fetch: health(404),
    });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      "ports 23020-65535 on 127.0.0.1 are all in use",
    );
    // 8080, then every port from 23020 up.
    expect(deps.isPortInUse).toHaveBeenCalledTimes(1 + 65_536 - 23_020);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  /** A spawn whose first smolvm fails to bind, as if it lost a race. */
  function loseFirstBind(files: ReturnType<typeof paths>) {
    const children = [fakeChild(), fakeChild()];
    children[1].pid = 4343;
    let spawned = 0;
    const spawn = vi.fn<Spawn>(() => {
      const child = children[spawned++];
      if (child === children[0]) {
        setImmediate(() => {
          appendFileSync(
            files.smolvmLogFile,
            "Error: io operation failed: Address already in use (os error 48)\n",
          );
          child.emit("exit", 1, null);
        });
      }
      return child;
    });
    return spawn;
  }

  it("tries the next port when smolvm cannot bind", async () => {
    const files = paths();
    const spawn = loseFirstBind(files);
    // The program that won the race for 23020 answers too, but is not smolvm.
    const deps = fakeDeps(fakeChild(), { spawn, fetch: devServerOn23020 });
    const smolvm = await mustStart(undefined, files, {}, deps);
    expect(spawn.mock.calls.map(([, args]) => args[3])).toEqual([
      "127.0.0.1:23020",
      "127.0.0.1:23021",
    ]);
    expect(smolvm.pid).toBe(4343);
    expect(smolvm.apiUrl).toBe("http://127.0.0.1:23021");
    expect(readFileSync(files.smolvmPidFile, "utf8")).toBe("4343\n");
  });

  it("stops when it loses the race for a port to another smolvm", async () => {
    const files = paths();
    const deps = fakeDeps(fakeChild(), {
      spawn: loseFirstBind(files),
      fetch: health(200),
    });
    await expect(startSmolvm(undefined, files, {}, deps)).rejects.toThrow(
      "a smolvm that amika-hostd did not start is already serving at http://127.0.0.1:23020",
    );
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("ignores bind errors an earlier run logged", async () => {
    const files = paths();
    mkdirSync(path.dirname(files.smolvmLogFile), { recursive: true });
    writeFileSync(
      files.smolvmLogFile,
      "Error: io operation failed: Address already in use (os error 98)\n",
    );
    const child = fakeChild();
    const deps = fakeDeps(child, { fetch: health(undefined) });
    const started = startSmolvm(undefined, files, {}, deps);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
    child.emit("exit", 2, null);
    await expect(started).rejects.toThrow(
      "smolvm exited with code 2 during startup",
    );
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when smolvm cannot bind SMOL_API_URL", async () => {
    const files = paths();
    const deps = fakeDeps(fakeChild(), {
      spawn: loseFirstBind(files),
      fetch: health(undefined),
    });
    await expect(
      startSmolvm("http://127.0.0.1:9000", files, {}, deps),
    ).rejects.toThrow(
      "another program is already listening at http://127.0.0.1:9000",
    );
    expect(deps.spawn).toHaveBeenCalledTimes(1);
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
    expect(existsSync(files.smolvmUrlFile)).toBe(false);
  });

  it("stops a smolvm that never starts serving", async () => {
    const child = fakeChild();
    const deps = fakeDeps(child, {
      fetch: health(undefined),
      readyTimeoutMs: 20,
      stopTimeoutMs: 20,
    });
    await expect(startSmolvm(undefined, paths(), {}, deps)).rejects.toThrow(
      "smolvm did not start serving at http://127.0.0.1:23020 within 0.02s",
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

  it("removes the pidfile when the URL file cannot be written", async () => {
    const files = paths();
    mkdirSync(files.smolvmUrlFile, { recursive: true });
    const child = fakeChild();
    await expect(
      startSmolvm(undefined, files, {}, fakeDeps(child)),
    ).rejects.toThrow(`cannot write ${files.smolvmUrlFile}: EISDIR`);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(existsSync(files.smolvmPidFile)).toBe(false);
  });

  it("stops waiting to serve once the signal aborts", async () => {
    const child = fakeChild();
    const shutdown = new AbortController();
    const deps = fakeDeps(child, {
      // The signal arrives once smolvm is spawned, while it starts up.
      spawn: vi.fn<Spawn>(() => {
        shutdown.abort();
        return child;
      }),
      fetch: health(undefined),
      signal: shutdown.signal,
    });
    const smolvm = await mustStart(undefined, paths(), {}, deps);
    expect(smolvm.running).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("stops looking for a port once the signal aborts", async () => {
    const shutdown = new AbortController();
    const deps = fakeDeps(fakeChild(), {
      isPortInUse: vi.fn(async (_host: string, port: number) => {
        if (port === 23_030) shutdown.abort();
        return true;
      }),
      fetch: health(404),
      signal: shutdown.signal,
    });
    expect(await startSmolvm(undefined, paths(), {}, deps)).toBeUndefined();
    // 8080, then 23020 to 23030, and no further.
    expect(deps.isPortInUse).toHaveBeenCalledTimes(12);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("gives up waiting on a slow stop without killing smolvm", async () => {
    const child = fakeChild();
    const deps = fakeDeps(child, { stopTimeoutMs: 20 });
    const smolvm = await mustStart(undefined, paths(), {}, deps);
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
    const smolvm = await mustStart(
      `http://127.0.0.1:${port}`,
      files,
      {},
      {
        findSmolvm: () => fake,
        // Ignore whatever this machine runs on 8080 (a smolvm, say).
        isPortInUse: (host, port) =>
          port === 8080 ? Promise.resolve(false) : isTcpPortInUse(host, port),
      },
    );
    expect(readFileSync(files.smolvmPidFile, "utf8")).toBe(`${smolvm.pid}\n`);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await response.text()).toBe("ok");
    expect(await smolvm.stop()).toBe(true);
    expect(await smolvm.exited).toBe("exited with code 0");
    await vi.waitFor(() => expect(existsSync(files.smolvmPidFile)).toBe(false));
    expect(existsSync(files.smolvmUrlFile)).toBe(false);
    expect(readFileSync(files.smolvmLogFile, "utf8")).toBe(
      "drain=1\nstopping machines\n",
    );
  }, 20_000);
});

describe("isTcpPortInUse", () => {
  it("sees any listener, not only an HTTP server", async () => {
    // The probe hangs up at once, which resets this end.
    const server = createServer((socket) =>
      socket.on("error", () => {}).end("not http"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      expect(await isTcpPortInUse("127.0.0.1", port)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await isTcpPortInUse("127.0.0.1", port)).toBe(false);
  });
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

describe("smolvmVersion", () => {
  const find = () => "/opt/smolvm";

  it("reads the version smolvm prints", () => {
    const run = vi.fn(() => "smolvm 1.25.0\n");
    expect(smolvmVersion({}, { find, run })).toBe("1.25.0");
    expect(run).toHaveBeenCalledWith("/opt/smolvm");
  });

  it("is undefined when smolvm is missing, fails, or prints no version", () => {
    expect(smolvmVersion({}, { find: () => undefined })).toBeUndefined();
    expect(
      smolvmVersion(
        {},
        {
          find,
          run: () => {
            throw new Error("exited with code 1");
          },
        },
      ),
    ).toBeUndefined();
    expect(smolvmVersion({}, { find, run: () => "smolvm" })).toBeUndefined();
  });
});

describe("isOlderVersion", () => {
  it("compares each part as a number", () => {
    expect(isOlderVersion("1.23.7", "1.24.0")).toBe(true);
    expect(isOlderVersion("1.9.0", "1.24.0")).toBe(true);
    expect(isOlderVersion("1.24.0", "1.24.0")).toBe(false);
    expect(isOlderVersion("1.24.10", "1.24.2")).toBe(false);
    expect(isOlderVersion("2.0.0", "1.24.0")).toBe(false);
  });
});
