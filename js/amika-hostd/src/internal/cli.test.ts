/** Cover command parsing and dispatch with every side effect injected. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AmikaApiError } from "./amika-api.js";
import { runCli, USAGE, type CliDeps } from "./cli.js";
import type { HostdConfigWith } from "./config.js";
import { DaemonError } from "./daemon.js";
import type { RunningServer } from "./server.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const ENV = {
  AMIKA_API_KEY: "api-key",
  AMIKA_HOSTD_HOSTNAME: "builder",
  AMIKA_HOSTD_SECRET_KEY: SECRET,
  XDG_STATE_HOME: "/state",
};
const HOST = { id: "host_1", hostname: "builder", url: null };

/** A state directory whose pidfile names a (pretend-live) daemon. */
function pidDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "amika-hostd-"));
  mkdirSync(path.join(dir, "amika-hostd"));
  writeFileSync(path.join(dir, "amika-hostd", "amika-hostd.pid"), "999999\n");
  return dir;
}

function harness(env: NodeJS.ProcessEnv = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const server: RunningServer = { port: 3020, close: vi.fn(async () => {}) };
  const release = vi.fn();
  const deps = {
    env,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    self: ["node", "cli.js"],
    shutdownSignal: vi.fn(async () => {}),
    loadConfigFile: vi.fn(() => undefined),
    startServer: vi.fn(async (_config: HostdConfigWith<"secretKey">) => server),
    startInBackground: vi.fn(async () => ({ pid: 77, port: 4000 })),
    claimPidFile: vi.fn(() => release),
    notifyReady: vi.fn(async (_port: number) => {}),
    isRunning: vi.fn(() => false),
    registerHost: vi.fn(async () => ({ host: HOST, created: true })),
  } satisfies CliDeps;
  return { deps, out, err, server, release };
}

describe("runCli", () => {
  it("backgrounds `up` by default, forwarding only the given flags", async () => {
    const { deps, out } = harness();
    expect(await runCli(["up", "--port", "4000"], deps)).toBe(0);
    expect(deps.startInBackground).toHaveBeenCalledWith(
      ["node", "cli.js", "serve", "--port", "4000"],
      {
        pidFile: "/state/amika-hostd/amika-hostd.pid",
        logFile: "/state/amika-hostd/amika-hostd.log",
      },
      { isRunning: deps.isRunning },
    );
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(out.slice(0, 2)).toEqual([
      "Registered host builder with https://app.amika.dev (host_1)",
      "amika-hostd started in the background on port 4000 (pid 77)",
    ]);
  });

  it.each([["up", "--fg"], ["serve"]])(
    "serves %s in the foreground until shutdown",
    async (...args) => {
      const { deps, out, server, release } = harness();
      expect(await runCli([...args, "--host", "0.0.0.0"], deps)).toBe(0);
      out.splice(0, args[0] === "up" ? 1 : 0);
      expect(deps.startServer).toHaveBeenCalledWith(
        expect.objectContaining({ host: "0.0.0.0", port: 3020 }),
      );
      expect(deps.claimPidFile).toHaveBeenCalledWith(
        "/state/amika-hostd/amika-hostd.pid",
        deps.isRunning,
      );
      expect(deps.notifyReady).toHaveBeenCalledWith(3020);
      expect(out).toEqual(["amika-hostd listening on http://0.0.0.0:3020"]);
      expect(deps.shutdownSignal).toHaveBeenCalled();
      expect(server.close).toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
      expect(deps.startInBackground).not.toHaveBeenCalled();
    },
  );

  it("prefers --port over the environment and TOML", async () => {
    const { deps } = harness({ ...ENV, AMIKA_HOSTD_PORT: "5000" });
    deps.loadConfigFile.mockReturnValue({
      path: "/etc/amika-hostd/config.toml",
      contents: "port = 6000",
    } as never);
    await runCli(["serve", "--port", "7000"], deps);
    expect(deps.startServer.mock.calls[0][0].port).toBe(7000);
    await runCli(["serve"], deps);
    expect(deps.startServer.mock.calls[1][0].port).toBe(5000);
  });

  it("releases the pidfile and reports a port that cannot be bound", async () => {
    const { deps, err, release } = harness();
    deps.startServer.mockRejectedValueOnce(
      Object.assign(new Error("in use"), { code: "EADDRINUSE" }),
    );
    expect(await runCli(["serve"], deps)).toBe(1);
    expect(err).toEqual([
      "amika-hostd: cannot listen on 127.0.0.1:3020: EADDRINUSE",
    ]);
    expect(release).toHaveBeenCalled();
    expect(deps.notifyReady).not.toHaveBeenCalled();
  });

  it("shuts down and releases the pidfile if `up` went away before ready", async () => {
    const { deps, err, release, server } = harness();
    deps.notifyReady.mockRejectedValueOnce(
      new DaemonError(
        "the launching `amika-hostd up` exited before startup finished",
      ),
    );
    expect(await runCli(["serve"], deps)).toBe(1);
    expect(err).toEqual([
      "amika-hostd: the launching `amika-hostd up` exited before startup finished",
    ]);
    expect(server.close).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(deps.shutdownSignal).not.toHaveBeenCalled();
  });

  it("fails before starting anything without a secret key", async () => {
    const { deps, err } = harness({ XDG_STATE_HOME: "/state" });
    expect(await runCli(["serve"], deps)).toBe(1);
    expect(err[0]).toMatch(/^amika-hostd: Missing required configuration:/);
    expect(deps.startServer).not.toHaveBeenCalled();
  });

  it("registers only the hostname and secret with the resolved API", async () => {
    const { deps } = harness({
      ...ENV,
      AMIKA_API_URL: "http://localhost:3000",
    });
    await runCli(["up"], deps);
    expect(deps.registerHost).toHaveBeenCalledWith(
      { apiUrl: "http://localhost:3000", apiKey: "api-key" },
      { hostname: "builder", secretKey: SECRET },
    );
  });

  it("reports a host that was already registered", async () => {
    const { deps, out } = harness();
    deps.registerHost.mockResolvedValueOnce({ host: HOST, created: false });
    await runCli(["up", "--fg"], deps);
    expect(out[0]).toBe(
      "Host builder is already registered with https://app.amika.dev (host_1)",
    );
  });

  it("does not register for `serve`", async () => {
    const { deps } = harness({ AMIKA_HOSTD_SECRET_KEY: SECRET });
    expect(await runCli(["serve"], deps)).toBe(0);
    expect(deps.registerHost).not.toHaveBeenCalled();
  });

  it("requires the API key and hostname for `up`", async () => {
    const { deps, err } = harness({ AMIKA_HOSTD_SECRET_KEY: SECRET });
    expect(await runCli(["up"], deps)).toBe(1);
    expect(err[0]).toContain("API key: set AMIKA_HOSTD_API_KEY");
    expect(err[0]).toContain("hostname: set AMIKA_HOSTD_HOSTNAME");
    expect(deps.registerHost).not.toHaveBeenCalled();
  });

  it("starts nothing when registration fails", async () => {
    const { deps, err } = harness();
    deps.registerHost.mockRejectedValueOnce(
      new AmikaApiError("Amika rejected the API key"),
    );
    expect(await runCli(["up"], deps)).toBe(1);
    expect(err).toEqual(["amika-hostd: Amika rejected the API key"]);
    expect(deps.startInBackground).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();
  });

  it("fails without calling Amika while a daemon is running", async () => {
    const { deps, err } = harness();
    deps.isRunning.mockReturnValue(true);
    const cli = runCli(["up"], {
      ...deps,
      env: { ...ENV, XDG_STATE_HOME: pidDir() },
    });
    expect(await cli).toBe(1);
    expect(err[0]).toMatch(/is already running \(pid 999999\)/);
    expect(deps.registerHost).not.toHaveBeenCalled();
  });

  it.each([
    [[], "missing command"],
    [["down"], "unknown command: down"],
    [["up", "extra"], "unexpected argument: extra"],
    [["serve", "--fg"], "--fg only applies to `up`"],
  ])("rejects %j with usage", async (args, message) => {
    const { deps, err } = harness();
    expect(await runCli(args, deps)).toBe(2);
    expect(err).toEqual([`amika-hostd: ${message}`, USAGE]);
  });

  it("rejects unknown options with usage", async () => {
    const { deps, err } = harness();
    expect(await runCli(["up", "--prot", "1"], deps)).toBe(2);
    expect(err[0]).toMatch(/Unknown option '--prot'/);
  });

  it("prints help without requiring configuration", async () => {
    const { deps, out } = harness({});
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(out).toEqual([USAGE]);
  });
});
