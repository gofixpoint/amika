/** Cover background startup handshakes and pidfile ownership. */
import { EventEmitter, once } from "node:events";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  claimPidFile,
  DaemonError,
  daemonPaths,
  PROCESS_TITLE,
  startInBackground,
  type Spawn,
} from "./daemon.js";

function paths() {
  const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
  return daemonPaths({ XDG_STATE_HOME: dir });
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    disconnect: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  });
  return child as typeof child & ChildProcess;
}

function spawning(child: ChildProcess) {
  return vi.fn<Spawn>(() => child);
}

const DAEMON_MODULE = fileURLToPath(new URL("./daemon.ts", import.meta.url));

/**
 * Run `code` as an ES module in a separate Node process. `process.argv[1]` is
 * this package's daemon module, followed by `args`.
 */
function runNode(
  code: string,
  args: string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      code,
      DAEMON_MODULE,
      ...args,
    ],
    { stdio: ["ignore", "pipe", "inherit"], ...options },
  );
}

/** Resolve with a process's trimmed stdout and exit code once it exits. */
async function finished(child: ChildProcess) {
  let stdout = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  const [code] = await once(child, "exit");
  return { stdout: stdout.trim(), code };
}

/** Resolve with the first line a process writes to stdout. */
async function firstLine(child: ChildProcess): Promise<string> {
  let stdout = "";
  for await (const chunk of child.stdout!) {
    stdout += chunk;
    if (stdout.includes("\n")) break;
  }
  return stdout.split("\n")[0];
}

/** Start a process that stays alive, titled `title`, until it is killed. */
async function liveProcess(title?: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${title ? `process.title = ${JSON.stringify(title)};` : ""}
       console.log("up"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout!, "data");
  return child;
}

const hasProc = existsSync(`/proc/${process.pid}/cmdline`);

describe("startInBackground", () => {
  it("detaches, logs to the log file, and resolves on the ready message", async () => {
    const child = fakeChild();
    const spawn = spawning(child);
    const files = paths();
    const started = startInBackground(["node", "cli.js", "serve"], files, {
      spawn,
    });
    child.emit("message", { type: "ready", port: 3020 });
    expect(await started).toEqual({ pid: 4242, port: 3020 });
    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["cli.js", "serve"],
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", expect.any(Number), expect.any(Number), "ipc"],
      }),
    );
    expect(child.disconnect).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
    expect(readFileSync(files.logFile, "utf8")).toBe("");
  });

  it("ignores unrelated messages until the ready message arrives", async () => {
    const child = fakeChild();
    const started = startInBackground(["node"], paths(), {
      spawn: spawning(child),
    });
    child.emit("message", { type: "log" });
    child.emit("message", { type: "ready", port: 1234 });
    expect((await started).port).toBe(1234);
  });

  it("reports an exit during startup with the log location", async () => {
    const child = fakeChild();
    const files = paths();
    const started = startInBackground(["node"], files, {
      spawn: spawning(child),
    });
    child.emit("exit", 1, null);
    await expect(started).rejects.toThrow(
      `amika-hostd exited during startup (code 1); see ${files.logFile}`,
    );
    expect(child.unref).not.toHaveBeenCalled();
  });

  it("kills a child that never becomes ready", async () => {
    const child = fakeChild();
    const started = startInBackground(["node"], paths(), {
      spawn: spawning(child),
      startupTimeoutMs: 10,
    });
    await expect(started).rejects.toThrow(/did not start within 0.01s/);
    expect(child.kill).toHaveBeenCalled();
  });

  it("refuses to start while the pidfile names a live process", async () => {
    const files = paths();
    claimPidFile(files.pidFile)();
    writeFileSync(files.pidFile, "999999\n");
    const spawn = spawning(fakeChild());
    await expect(
      startInBackground(["node"], files, { spawn, isRunning: () => true }),
    ).rejects.toThrow("amika-hostd is already running (pid 999999)");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("claimPidFile", () => {
  it("writes this pid and removes the file on release", () => {
    const { pidFile } = paths();
    const release = claimPidFile(pidFile);
    expect(readFileSync(pidFile, "utf8")).toBe(`${process.pid}\n`);
    release();
    expect(() => readFileSync(pidFile)).toThrow();
  });

  it("replaces a stale pidfile", () => {
    const { pidFile } = paths();
    claimPidFile(pidFile)();
    writeFileSync(pidFile, "999999\n");
    const release = claimPidFile(pidFile, () => false);
    expect(readFileSync(pidFile, "utf8")).toBe(`${process.pid}\n`);
    release();
  });

  it("refuses a pidfile held by another live daemon", () => {
    const { pidFile } = paths();
    claimPidFile(pidFile)();
    writeFileSync(pidFile, "999999\n");
    expect(() => claimPidFile(pidFile, () => true)).toThrow(
      "amika-hostd is already running (pid 999999)",
    );
  });

  it("leaves a pidfile another daemon has since claimed", () => {
    const { pidFile } = paths();
    const release = claimPidFile(pidFile);
    writeFileSync(pidFile, "999999\n");
    release();
    expect(readFileSync(pidFile, "utf8")).toBe("999999\n");
  });
});

describe("state directory errors", () => {
  it("reports an unusable state directory instead of crashing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
    const notADirectory = path.join(dir, "file");
    writeFileSync(notADirectory, "");
    const files = daemonPaths({ XDG_STATE_HOME: notADirectory });
    await expect(
      startInBackground(["node"], files, { spawn: spawning(fakeChild()) }),
    ).rejects.toThrow(
      new DaemonError(`cannot create ${files.logFile}: ENOTDIR`),
    );
    expect(() => claimPidFile(files.pidFile)).toThrow(
      new DaemonError(`cannot create ${files.pidFile}: ENOTDIR`),
    );
  });
});

describe("claimPidFile across processes", () => {
  it("lets exactly one of several daemons starting at once claim it", async () => {
    const { pidFile } = paths();
    const startAt = String(Date.now() + 1_500);
    // Each child reports its outcome, then holds until killed, so the winner
    // is still alive however late the others reach the claim. The exit timer
    // only guards against orphans if the test times out before killing them.
    const claim = `
      const { claimPidFile, PROCESS_TITLE } = await import(process.argv[1]);
      process.title = PROCESS_TITLE;
      await new Promise((r) => setTimeout(r, Number(process.argv[3]) - Date.now()));
      try {
        claimPidFile(process.argv[2]);
        console.log("claimed");
      } catch (error) {
        console.log(error.name);
      }
      setTimeout(() => process.exit(), 30_000);
    `;
    const children = Array.from({ length: 5 }, () =>
      runNode(claim, [pidFile, startAt]),
    );
    try {
      const outputs = await Promise.all(children.map(firstLine));
      expect(outputs.sort()).toEqual([
        "DaemonError",
        "DaemonError",
        "DaemonError",
        "DaemonError",
        "claimed",
      ]);
      // No temp files are left behind, only the winner's pidfile.
      expect(readdirSync(path.dirname(pidFile))).toEqual(["amika-hostd.pid"]);
    } finally {
      for (const child of children) child.kill();
    }
  }, 20_000);

  it.runIf(hasProc)(
    "treats a pid reused by an unrelated process as stale",
    async () => {
      const { pidFile } = paths();
      const unrelated = await liveProcess();
      try {
        claimPidFile(pidFile)();
        writeFileSync(pidFile, `${unrelated.pid}\n`);
        const release = claimPidFile(pidFile);
        expect(readFileSync(pidFile, "utf8")).toBe(`${process.pid}\n`);
        release();
      } finally {
        unrelated.kill();
      }
    },
  );

  it("refuses a live amika-hostd and says how to recover", async () => {
    const { pidFile } = paths();
    const daemon = await liveProcess(PROCESS_TITLE);
    try {
      claimPidFile(pidFile)();
      writeFileSync(pidFile, `${daemon.pid}\n`);
      expect(() => claimPidFile(pidFile)).toThrow(
        `amika-hostd is already running (pid ${daemon.pid}); if it is not, remove ${pidFile}`,
      );
    } finally {
      daemon.kill();
    }
  });
});

describe("notifyReady", () => {
  const notify = `
    const { notifyReady } = await import(process.argv[1]);
    await new Promise((r) => setTimeout(r, 200));
    try {
      await notifyReady(3020);
      console.log("sent");
    } catch (error) {
      console.log(error.message);
    }
  `;

  it("sends the ready message to the launching process", async () => {
    const child = runNode(notify, [], {
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    const [message] = await once(child, "message");
    expect(message).toEqual({ type: "ready", port: 3020 });
    expect(await finished(child)).toEqual({ stdout: "sent", code: 0 });
  }, 20_000);

  it("rejects instead of crashing when the launcher has gone", async () => {
    const child = runNode(notify, [], {
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    child.disconnect();
    expect(await finished(child)).toEqual({
      stdout: "the launching `amika-hostd up` exited before startup finished",
      code: 0,
    });
  }, 20_000);
});

describe("daemonPaths", () => {
  it("lives under XDG_STATE_HOME", () => {
    expect(daemonPaths({ XDG_STATE_HOME: "/state" })).toEqual({
      pidFile: "/state/amika-hostd/amika-hostd.pid",
      logFile: "/state/amika-hostd/amika-hostd.log",
    });
  });
});
