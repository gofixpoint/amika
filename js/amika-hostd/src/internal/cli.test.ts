/** Cover command parsing and dispatch with every side effect injected. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AmikaApiError } from "./amika-api.js";
import { PromptCancelled, runCli, USAGE, type CliDeps } from "./cli.js";
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
const HOST = {
  id: "host_1",
  hostname: "builder",
  url: "https://builder.example.com" as string | null,
};
const NEW_HOST = { ...HOST, url: null };

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
    setHostUrl: vi.fn(
      async (_api, host: { hostname: string }, url: string) => ({
        ...HOST,
        hostname: host.hostname,
        url,
      }),
    ),
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
      { isRunning: deps.isRunning, env: expect.any(Object) },
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
      expect(out).toEqual([
        "amika-hostd listening on http://0.0.0.0:3020",
        ...(args[0] === "up"
          ? [
              "Amika reaches this host at https://builder.example.com; make sure it is exposed there and forwards to http://0.0.0.0:3020.",
            ]
          : []),
      ]);
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
    expect(out.slice(0, 2)).toEqual([
      "Host builder is already registered with https://app.amika.dev (host_1)",
      "Amika keeps the secret key stored when the host was first registered; if yours has changed since, Amika's requests to this host will be rejected.",
    ]);
  });

  it("keeps the API key out of the background daemon's environment", async () => {
    const { deps } = harness({
      ...ENV,
      AMIKA_API_KEY: "general-key",
      AMIKA_HOSTD_API_KEY: "general-key",
      PATH: "/usr/bin",
    });
    await runCli(["up"], deps);
    const [, , { env }] = deps.startInBackground.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { env: NodeJS.ProcessEnv },
    ];
    expect(env).not.toHaveProperty("AMIKA_API_KEY");
    expect(env).not.toHaveProperty("AMIKA_HOSTD_API_KEY");
    expect(env).toMatchObject({
      AMIKA_HOSTD_SECRET_KEY: SECRET,
      AMIKA_HOSTD_HOSTNAME: "builder",
      PATH: "/usr/bin",
    });
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
    [["serve", "--fg"], "--fg does not apply to `serve`"],
    [["register-url"], "missing <url>"],
    [["register-url", "a", "b"], "unexpected argument: b"],
    [["register-url", "ftp://x"], "not an http(s) URL: ftp://x"],
    [
      ["register-url", "https://user:pw@x.example"],
      "not an http(s) URL: https://user:pw@x.example",
    ],
    [
      ["register-url", "https://x.example", "--port", "1"],
      "--port does not apply to `register-url`",
    ],
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

describe("completing registration", () => {
  function unregistered(answers?: (string | undefined)[]) {
    const h = harness();
    h.deps.registerHost.mockResolvedValue({ host: NEW_HOST, created: true });
    const prompt = answers
      ? vi.fn(async (_question: string) => answers.shift())
      : undefined;
    return { ...h, deps: { ...h.deps, prompt } };
  }

  it("register-url registers idempotently, then sets the URL", async () => {
    const { deps, out } = unregistered();
    expect(await runCli(["register-url", "https://abc.ngrok.app/"], deps)).toBe(
      0,
    );
    expect(deps.setHostUrl).toHaveBeenCalledWith(
      { apiUrl: "https://app.amika.dev", apiKey: "api-key" },
      NEW_HOST,
      "https://abc.ngrok.app",
    );
    expect(out).toEqual([
      "Registered host builder with https://app.amika.dev (host_1)",
      "Set the public URL of host builder to https://abc.ngrok.app",
    ]);
    expect(deps.startInBackground).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();
  });

  it("register-url keeps a path the tunnel needs", async () => {
    const { deps } = unregistered();
    await runCli(["register-url", "https://example.com/hostd/"], deps);
    expect(deps.setHostUrl.mock.calls[0][2]).toBe("https://example.com/hostd/");
  });

  it("register-url requires the same settings as `up`", async () => {
    const { deps, err } = unregistered();
    const run = runCli(["register-url", "https://x.example"], {
      ...deps,
      env: { AMIKA_HOSTD_SECRET_KEY: SECRET },
    });
    expect(await run).toBe(1);
    expect(err[0]).toContain("API key: set AMIKA_HOSTD_API_KEY");
    expect(deps.registerHost).not.toHaveBeenCalled();
  });

  /** Shut down only after `afterStart` has had time to finish. */
  const shutdownLater = () =>
    vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

  const EXPOSE =
    "To complete registration, expose http://127.0.0.1:4000 to the internet (e.g. `ngrok http 4000` or `cloudflared tunnel --url http://127.0.0.1:4000`) and give Amika its public URL.";
  const LATER =
    "Run `amika-hostd register-url <url>` to complete registration.";

  it("`up` starts the daemon, then asks for the URL, retrying until valid", async () => {
    const { deps, out, err } = unregistered([
      "not a url",
      " https://abc.trycloudflare.com ",
    ]);
    expect(await runCli(["up"], deps)).toBe(0);
    // The daemon is running before the operator is asked to expose it.
    expect(deps.startInBackground.mock.invocationCallOrder[0]).toBeLessThan(
      deps.prompt!.mock.invocationCallOrder[0],
    );
    expect(deps.prompt).toHaveBeenCalledTimes(2);
    expect(err).toEqual(["Not an http(s) URL: not a url"]);
    expect(deps.setHostUrl.mock.calls[0][2]).toBe(
      "https://abc.trycloudflare.com",
    );
    expect(out.slice(1, 2)).toEqual([
      "amika-hostd started in the background on port 4000 (pid 77)",
    ]);
    expect(out.slice(4)).toEqual([
      EXPOSE,
      "Set the public URL of host builder to https://abc.trycloudflare.com",
    ]);
  });

  it("`up --fg` serves, then asks for the URL, then keeps serving", async () => {
    const { deps, out, server } = unregistered(["https://abc.ngrok.app"]);
    deps.shutdownSignal = shutdownLater();
    expect(await runCli(["up", "--fg"], deps)).toBe(0);
    expect(deps.startServer.mock.invocationCallOrder[0]).toBeLessThan(
      deps.prompt!.mock.invocationCallOrder[0],
    );
    expect(out.slice(1)).toEqual([
      "amika-hostd listening on http://127.0.0.1:3020",
      EXPOSE.replaceAll("4000", "3020"),
      "Set the public URL of host builder to https://abc.ngrok.app",
    ]);
    expect(deps.shutdownSignal).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
  });

  it.each([[""], [undefined]])(
    "`up` keeps the daemon running when the prompt is skipped with %j",
    async (answer) => {
      const { deps, out } = unregistered([answer]);
      expect(await runCli(["up"], deps)).toBe(0);
      expect(deps.setHostUrl).not.toHaveBeenCalled();
      expect(out.at(-1)).toBe(`Skipped. ${LATER}`);
      expect(deps.startInBackground).toHaveBeenCalled();
    },
  );

  it("`up` leaves the background daemon running when the prompt is cancelled", async () => {
    const { deps, err } = unregistered();
    const prompt = vi.fn(async (_question: string): Promise<string> => {
      throw new PromptCancelled();
    });
    expect(await runCli(["up"], { ...deps, prompt })).toBe(130);
    expect(err).toEqual([
      `amika-hostd: cancelled; the daemon is still running. ${LATER}`,
    ]);
    expect(deps.startInBackground).toHaveBeenCalled();
    expect(deps.setHostUrl).not.toHaveBeenCalled();
  });

  it("`up --fg` stops the server when the prompt is cancelled", async () => {
    const { deps, err, server, release } = unregistered();
    const prompt = vi.fn(async (_question: string): Promise<string> => {
      throw new PromptCancelled();
    });
    const shutdownSignal = vi.fn(() => new Promise<void>(() => {}));
    expect(
      await runCli(["up", "--fg"], { ...deps, prompt, shutdownSignal }),
    ).toBe(130);
    expect(err).toEqual([
      `amika-hostd: cancelled; the daemon stopped. ${LATER}`,
    ]);
    expect(server.close).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("`up` without a terminal starts the daemon and explains how to finish", async () => {
    const { deps, out } = unregistered();
    expect(await runCli(["up"], deps)).toBe(0);
    expect(deps.startInBackground).toHaveBeenCalled();
    expect(out.slice(-2)).toEqual([EXPOSE, LATER]);
  });

  it.each([
    ["::1", "http://[::1]:3020"],
    ["0.0.0.0", "http://0.0.0.0:3020"],
  ])("`up --fg --host %s` prints a usable local URL", async (host, url) => {
    const { deps, out } = unregistered();
    expect(await runCli(["up", "--fg", "--host", host], deps)).toBe(0);
    expect(out[1]).toBe(`amika-hostd listening on ${url}`);
    expect(out[2]).toContain(`expose ${url} to the internet`);
  });

  it("`up` with a registered URL starts the daemon and says where it is expected", async () => {
    const h = harness();
    const prompt = vi.fn(async () => "https://other.example");
    expect(await runCli(["up"], { ...h.deps, prompt })).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(h.deps.setHostUrl).not.toHaveBeenCalled();
    expect(h.deps.startInBackground).toHaveBeenCalled();
    expect(h.out.at(-1)).toBe(
      "Amika reaches this host at https://builder.example.com; make sure it is exposed there and forwards to http://127.0.0.1:4000.",
    );
  });

  it("`up` reports a failed save and leaves the daemon running", async () => {
    const { deps, err } = unregistered(["https://abc.ngrok.app"]);
    deps.setHostUrl.mockRejectedValueOnce(
      new AmikaApiError("failed to set the host URL (HTTP 500)"),
    );
    expect(await runCli(["up"], deps)).toBe(1);
    expect(err).toEqual([
      "amika-hostd: failed to set the host URL (HTTP 500)",
      `The daemon is still running. ${LATER}`,
    ]);
    expect(deps.startInBackground).toHaveBeenCalled();
  });

  it("`up --fg` keeps serving after a failed save", async () => {
    const { deps, err, server } = unregistered(["https://abc.ngrok.app"]);
    deps.shutdownSignal = shutdownLater();
    deps.setHostUrl.mockRejectedValueOnce(
      new AmikaApiError("failed to set the host URL (HTTP 500)"),
    );
    expect(await runCli(["up", "--fg"], deps)).toBe(0);
    expect(err).toEqual([
      "amika-hostd: failed to set the host URL (HTTP 500)",
      "The daemon is still running. Run `amika-hostd register-url <url>` to complete registration.",
    ]);
    // Still serving after the failure: the server closed only on shutdown.
    expect(vi.mocked(server.close).mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.setHostUrl.mock.invocationCallOrder[0],
    );
    expect(deps.shutdownSignal).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
  });
});
