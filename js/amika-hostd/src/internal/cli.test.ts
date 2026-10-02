/** Cover command parsing and dispatch with every side effect injected. */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AmikaApiError } from "./amika-api.js";
import { PromptCancelled, runCli, USAGE, type CliDeps } from "./cli.js";
import type { HostdConfigFile, HostdConfigWith } from "./config.js";
import { DaemonError } from "./daemon.js";
import type { RunningServer } from "./server.js";
import type { ManagedSmolvm, SmolvmDeps } from "./smolvm-serve.js";

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

/** A credential store that never touches the keychain or disk. */
function memoryStore(value?: string) {
  const store = {
    description: "the test store",
    value,
    get: vi.fn(() => store.value),
    set: vi.fn((next: string) => {
      store.value = next;
    }),
  };
  return store;
}

function harness(env: NodeJS.ProcessEnv = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const server: RunningServer = { port: 3020, close: vi.fn(async () => {}) };
  const release = vi.fn();
  let smolvmExit: (reason: string) => void = () => {};
  // By default the shutdown signal arrives once the daemon is ready.
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (signalReady = resolve));
  let smolvmRunning = true;
  const smolvm: ManagedSmolvm = {
    pid: 88,
    exited: new Promise((resolve) => (smolvmExit = resolve)),
    get running() {
      return smolvmRunning;
    },
    stop: vi.fn(async () => true),
  };
  const deps = {
    env,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    self: ["node", "cli.js"],
    shutdownSignal: vi.fn(() => ready),
    loadConfigFile: vi.fn((): HostdConfigFile | undefined => undefined),
    startServer: vi.fn(async (_config: HostdConfigWith<"secretKey">) => server),
    startInBackground: vi.fn(async () => ({ pid: 77, port: 4000 })),
    startSmolvm: vi.fn(
      async (
        _url: string | undefined,
        _paths,
        _env: NodeJS.ProcessEnv,
        _options?: SmolvmDeps,
      ) => smolvm,
    ),
    stopProcess: vi.fn(
      async (
        _pid: number,
        _isRunning: (pid: number) => boolean,
        _options: { timeoutMs: number },
      ) => true,
    ),
    isSmolvmRunning: vi.fn(() => false),
    claimPidFile: vi.fn(() => release),
    notifyReady: vi.fn(async (_port: number) => signalReady()),
    isRunning: vi.fn(() => false),
    credentials: memoryStore(),
    registerHost: vi.fn(async () => ({ host: HOST, created: true })),
    setHostSizes: vi.fn(async () => HOST),
    setHostUrl: vi.fn(
      async (_api, host: { hostname: string }, url: string) => ({
        ...HOST,
        hostname: host.hostname,
        url,
      }),
    ),
  } satisfies CliDeps;
  return {
    deps,
    out,
    err,
    server,
    release,
    smolvm,
    smolvmExit: (reason: string) => {
      smolvmRunning = false;
      smolvmExit(reason);
    },
  };
}

describe("runCli", () => {
  it("backgrounds `up` by default, forwarding only the given flags", async () => {
    const { deps, out } = harness();
    expect(await runCli(["up", "--port", "4000"], deps)).toBe(0);
    expect(deps.startInBackground).toHaveBeenCalledWith(
      ["node", "cli.js", "serve", "--smolvm", "--port", "4000"],
      {
        pidFile: "/state/amika-hostd/amika-hostd.pid",
        logFile: "/state/amika-hostd/log/amika-hostd.log",
        smolvmPidFile: "/state/amika-hostd/smolvm.pid",
        smolvmLogFile: "/state/amika-hostd/log/smolvm.log",
        servicesFile: "/state/amika-hostd/services.json",
      },
      { isRunning: deps.isRunning, env: expect.any(Object) },
    );
    expect(deps.startServer).not.toHaveBeenCalled();
    // The background daemon starts smolvm, not `up` itself.
    expect(deps.startSmolvm).not.toHaveBeenCalled();
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
      out.splice(0, args[0] === "up" ? 2 : 0);
      expect(deps.startServer).toHaveBeenCalledWith(
        expect.objectContaining({ host: "0.0.0.0", port: 3020 }),
        { servicesFile: "/state/amika-hostd/services.json" },
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
              "Stopping smolvm (pid 88) and its machines",
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
  });

  it("fails before starting anything without a secret key", async () => {
    const { deps, err } = harness({ XDG_STATE_HOME: "/state" });
    expect(await runCli(["serve"], deps)).toBe(1);
    expect(err[0]).toMatch(/^amika-hostd: Missing required configuration:/);
    expect(deps.startServer).not.toHaveBeenCalled();
  });

  it("registers the hostname, secret and sizes with the resolved API", async () => {
    const { deps } = harness({
      ...ENV,
      AMIKA_API_URL: "http://localhost:3000",
    });
    await runCli(["up"], deps);
    expect(deps.registerHost).toHaveBeenCalledWith(
      { apiUrl: "http://localhost:3000", apiKey: "api-key" },
      {
        hostname: "builder",
        secretKey: SECRET,
        sizes: {},
      },
    );
    // A new host was registered with its sizes; nothing to update.
    expect(deps.setHostSizes).not.toHaveBeenCalled();
  });

  it("updates an existing host's sizes from the config", async () => {
    const { deps, out } = harness();
    deps.loadConfigFile.mockReturnValue({
      path: "/etc/amika-hostd/config.toml",
      contents: `[sizes.large]\nvcpus = 8\nmemory_gib = 32\ndisk_gib = 100`,
    });
    deps.registerHost.mockResolvedValueOnce({ host: HOST, created: false });
    await runCli(["up", "--fg"], deps);
    expect(deps.setHostSizes).toHaveBeenCalledWith(
      { apiUrl: "https://app.amika.dev", apiKey: "api-key" },
      HOST,
      { large: { vcpus: 8, memoryGib: 32, diskGib: 100, diskGrowOnly: false } },
    );
    expect(out).toContain("Updated the sizes of host builder (large)");
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
    expect(err[0]).toContain("API key: run `amika-hostd setup`");
    expect(err[0]).toContain("hostname: run `amika-hostd setup`");
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
    [["start"], "unknown command: start"],
    [["down", "extra"], "unexpected argument: extra"],
    [["down", "--port", "1"], "--port does not apply to `down`"],
    [["up", "--smolvm"], "--smolvm does not apply to `up`"],
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
    expect(err[0]).toContain("API key: run `amika-hostd setup`");
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
      "",
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
      "smolvm serving at http://127.0.0.1:8080 (pid 88); logs: /state/amika-hostd/log/smolvm.log",
      "amika-hostd listening on http://127.0.0.1:3020",
      "",
      EXPOSE.replaceAll("4000", "3020"),
      "Set the public URL of host builder to https://abc.ngrok.app",
      "Stopping smolvm (pid 88) and its machines",
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
    expect(out[2]).toBe(`amika-hostd listening on ${url}`);
    expect(out[3]).toBe("");
    expect(out[4]).toContain(`expose ${url} to the internet`);
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

describe("managing smolvm", () => {
  it("`up --fg` starts smolvm before serving and stops it after", async () => {
    const { deps, server, release, smolvm } = harness({
      ...ENV,
      AMIKA_HOSTD_SECRET_KEY: undefined,
      AMIKA_SECRET_KEY: SECRET,
      SMOL_API_URL: "http://127.0.0.1:9090",
      OTHER: "kept",
    });
    expect(await runCli(["up", "--fg"], deps)).toBe(0);
    const [url, paths, env] = deps.startSmolvm.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9090");
    expect(paths.smolvmPidFile).toBe("/state/amika-hostd/smolvm.pid");
    // smolvm needs neither the API key nor the secret key.
    expect(env).not.toHaveProperty("AMIKA_API_KEY");
    expect(env).not.toHaveProperty("AMIKA_SECRET_KEY");
    expect(env.OTHER).toBe("kept");
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(deps.startSmolvm)).toBeLessThan(order(deps.startServer));
    expect(order(vi.mocked(server.close))).toBeLessThan(
      order(vi.mocked(smolvm.stop)),
    );
    expect(order(vi.mocked(smolvm.stop))).toBeLessThan(order(release));
  });

  it("starts smolvm for `serve` only with --smolvm", async () => {
    const { deps } = harness();
    await runCli(["serve"], deps);
    expect(deps.startSmolvm).not.toHaveBeenCalled();
    await runCli(["serve", "--smolvm"], deps);
    expect(deps.startSmolvm).toHaveBeenCalledTimes(1);
  });

  it("serves nothing and releases the pidfile when smolvm cannot start", async () => {
    const { deps, err, release } = harness();
    deps.startSmolvm.mockRejectedValueOnce(
      new DaemonError("smolvm not found on PATH"),
    );
    expect(await runCli(["serve", "--smolvm"], deps)).toBe(1);
    expect(err).toEqual(["amika-hostd: smolvm not found on PATH"]);
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("stops smolvm when the daemon cannot listen", async () => {
    const { deps, release, smolvm } = harness();
    deps.startServer.mockRejectedValueOnce(
      Object.assign(new Error("in use"), { code: "EADDRINUSE" }),
    );
    expect(await runCli(["serve", "--smolvm"], deps)).toBe(1);
    expect(smolvm.stop).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("stops serving when smolvm exits on its own", async () => {
    const { deps, err, server, smolvm, smolvmExit } = harness();
    deps.shutdownSignal = vi.fn(() => new Promise<void>(() => {}));
    const cli = runCli(["serve", "--smolvm"], deps);
    await vi.waitFor(() => expect(deps.notifyReady).toHaveBeenCalled());
    smolvmExit("exited with code 1");
    expect(await cli).toBe(1);
    expect(err).toEqual([
      "amika-hostd: smolvm exited with code 1, so amika-hostd stopped too; see /state/amika-hostd/log/smolvm.log",
    ]);
    expect(server.close).toHaveBeenCalled();
    // It is already gone, so there is nothing to stop.
    expect(smolvm.stop).not.toHaveBeenCalled();
  });

  it("stops smolvm, without serving, when signalled while it starts", async () => {
    const { deps, smolvm, release } = harness();
    let signal: () => void = () => {};
    deps.shutdownSignal = vi.fn(
      () => new Promise<void>((resolve) => (signal = resolve)),
    );
    // The signal arrives while smolvm is starting, which then returns early.
    deps.startSmolvm.mockImplementationOnce(
      async (_url, _paths, _env, options) => {
        signal();
        await vi.waitFor(() => expect(options?.signal?.aborted).toBe(true));
        return smolvm;
      },
    );
    expect(await runCli(["serve", "--smolvm"], deps)).toBe(0);
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.notifyReady).not.toHaveBeenCalled();
    expect(smolvm.stop).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("says so when smolvm is still stopping its machines", async () => {
    const { deps, err, smolvm } = harness();
    vi.mocked(smolvm.stop).mockResolvedValueOnce(false);
    expect(await runCli(["serve", "--smolvm"], deps)).toBe(0);
    expect(err).toEqual([
      "amika-hostd: smolvm (pid 88) is still stopping its machines; `amika-hostd down` waits for it",
    ]);
  });
});

describe("down", () => {
  /** A state directory whose pidfiles name a daemon and a smolvm. */
  function running() {
    const dir = pidDir();
    writeFileSync(path.join(dir, "amika-hostd", "smolvm.pid"), "888888\n");
    const h = harness({ XDG_STATE_HOME: dir });
    return { ...h, dir };
  }

  it("says so when nothing is running", async () => {
    const { deps, out } = harness();
    expect(await runCli(["down"], deps)).toBe(0);
    expect(out).toEqual(["amika-hostd is not running"]);
    expect(deps.stopProcess).not.toHaveBeenCalled();
  });

  it("stops the daemon, which stops its smolvm", async () => {
    const { deps, out } = running();
    deps.isRunning.mockReturnValue(true);
    expect(await runCli(["down"], deps)).toBe(0);
    expect(deps.stopProcess).toHaveBeenCalledTimes(1);
    expect(deps.stopProcess.mock.calls[0]).toEqual([
      999999,
      deps.isRunning,
      { timeoutMs: expect.any(Number) },
    ]);
    expect(out).toEqual([
      "Stopping amika-hostd (pid 999999)",
      "Stopped amika-hostd",
    ]);
  });

  it("stops a smolvm the daemon left behind", async () => {
    const { deps, out, dir } = running();
    deps.isSmolvmRunning.mockReturnValue(true);
    expect(await runCli(["down"], deps)).toBe(0);
    expect(deps.stopProcess.mock.calls.map((call) => call[0])).toEqual([
      888888,
    ]);
    expect(out).toEqual([
      "Stopping smolvm (pid 888888) and its machines",
      "Stopped smolvm",
    ]);
    // No daemon is left to remove its pidfile.
    expect(existsSync(path.join(dir, "amika-hostd", "smolvm.pid"))).toBe(false);
  });

  it("leaves a pidfile naming another live process, and says so", async () => {
    const dir = pidDir();
    writeFileSync(
      path.join(dir, "amika-hostd", "amika-hostd.pid"),
      `${process.pid}\n`,
    );
    const { deps, out, err } = harness({ XDG_STATE_HOME: dir });
    expect(await runCli(["down"], deps)).toBe(0);
    expect(deps.stopProcess).not.toHaveBeenCalled();
    expect(out).toEqual(["amika-hostd is not running"]);
    if (!existsSync(`/proc/${process.pid}/cmdline`)) {
      expect(err[0]).toMatch(/names pid \d+, which is not amika-hostd/);
    }
  });

  it("fails when the daemon does not exit", async () => {
    const { deps, err, dir } = running();
    deps.isRunning.mockReturnValue(true);
    deps.stopProcess.mockResolvedValueOnce(false);
    expect(await runCli(["down"], deps)).toBe(1);
    expect(err).toEqual([
      `amika-hostd: amika-hostd (pid 999999) did not exit within 70s; see ${path.join(dir, "amika-hostd", "log", "amika-hostd.log")}`,
    ]);
  });

  it("does not need a valid configuration", async () => {
    const { deps } = harness();
    deps.loadConfigFile.mockReturnValue({
      path: "/etc/amika-hostd/config.toml",
      contents: "not toml [",
    });
    expect(await runCli(["down"], deps)).toBe(0);
  });
});

describe("setup", () => {
  const CONFIG_PATH = "/config/amika-hostd/config.toml";

  /** A harness whose config file `setup` writes, and `up` then reads. */
  function unconfigured(
    answers: (string | undefined)[],
    keys: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ) {
    const h = harness({
      XDG_STATE_HOME: "/state",
      XDG_CONFIG_HOME: "/config",
      ...env,
    });
    const files: Record<string, string> = {};
    const deps = {
      ...h.deps,
      prompt: vi.fn(async (_question: string) => answers.shift()),
      promptSecret: vi.fn(async (_question: string) => keys.shift()),
      loadConfigFile: vi.fn((): HostdConfigFile | undefined =>
        CONFIG_PATH in files
          ? { path: CONFIG_PATH, contents: files[CONFIG_PATH] }
          : undefined,
      ),
      writeConfigFile: vi.fn((file: string, contents: string) => {
        files[file] = contents;
      }),
      systemHostname: () => "builder",
      generateSecretKey: () => SECRET,
    };
    return { ...h, deps, files };
  }

  it("`setup` writes the config and stores the API key", async () => {
    const { deps, files, out } = unconfigured([""], ["amk_123"]);
    expect(await runCli(["setup"], deps)).toBe(0);
    expect(files[CONFIG_PATH]).toContain('hostname = "builder"');
    expect(files[CONFIG_PATH]).toContain(`secret_key = "${SECRET}"`);
    expect(deps.credentials.value).toBe("amk_123");
    expect(out.at(-1)).toBe(
      "To stop the daemon and its VMs, run `amika-hostd down`.",
    );
    expect(deps.registerHost).not.toHaveBeenCalled();
  });

  it("`setup` needs a terminal", async () => {
    const { deps, err } = harness({});
    expect(await runCli(["setup"], deps)).toBe(1);
    expect(err).toEqual([
      "amika-hostd: `amika-hostd setup` asks questions, so run it in a terminal",
    ]);
  });

  it("`setup` takes no options", async () => {
    const { deps } = harness({});
    expect(await runCli(["setup", "--port", "1"], deps)).toBe(2);
  });

  it("`setup` reports Ctrl-C as a change to nothing", async () => {
    const { deps, err } = unconfigured([]);
    deps.prompt.mockRejectedValueOnce(new PromptCancelled());
    expect(await runCli(["setup"], deps)).toBe(130);
    expect(err).toEqual(["amika-hostd: setup cancelled; nothing was changed."]);
    expect(deps.writeConfigFile).not.toHaveBeenCalled();
  });

  it("`up` runs setup first when unconfigured, then registers with the stored key", async () => {
    const { deps, out } = unconfigured([""], ["amk_123"]);
    expect(await runCli(["up"], deps)).toBe(0);
    expect(out[0]).toBe(
      "amika-hostd is not set up yet, so running setup first.",
    );
    expect(out.join("\n")).not.toContain("Start the daemon with");
    expect(deps.registerHost).toHaveBeenCalledWith(
      { apiUrl: "https://app.amika.dev", apiKey: "amk_123" },
      expect.objectContaining({ hostname: "builder", secretKey: SECRET }),
    );
    expect(deps.startInBackground).toHaveBeenCalled();
  });

  it("`up` runs setup when only the API key is missing", async () => {
    const { deps } = unconfigured([""], ["amk_123"], {
      AMIKA_HOSTD_HOSTNAME: "builder",
      AMIKA_HOSTD_SECRET_KEY: SECRET,
    });
    expect(await runCli(["up"], deps)).toBe(0);
    expect(deps.promptSecret).toHaveBeenCalled();
    expect(deps.registerHost).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "amk_123" }),
      expect.anything(),
    );
  });

  it("`up` without a terminal fails, naming setup", async () => {
    const { deps, err } = harness({ XDG_STATE_HOME: "/state" });
    expect(await runCli(["up"], deps)).toBe(1);
    expect(err[0]).toContain("API key: run `amika-hostd setup`");
  });

  it("`up` stops if setup is cancelled", async () => {
    const { deps } = unconfigured([]);
    deps.prompt.mockRejectedValueOnce(new PromptCancelled());
    expect(await runCli(["up"], deps)).toBe(130);
    expect(deps.registerHost).not.toHaveBeenCalled();
  });

  it("`up` uses a stored API key without running setup", async () => {
    const { deps } = harness({
      AMIKA_HOSTD_HOSTNAME: "builder",
      AMIKA_HOSTD_SECRET_KEY: SECRET,
      XDG_STATE_HOME: "/state",
    });
    deps.credentials.value = "amk_stored";
    expect(await runCli(["up"], deps)).toBe(0);
    expect(deps.registerHost.mock.calls[0]).toEqual([
      { apiUrl: "https://app.amika.dev", apiKey: "amk_stored" },
      expect.anything(),
    ]);
  });

  it("the environment's API key wins over the stored one", async () => {
    const { deps } = harness();
    deps.credentials.value = "amk_stored";
    await runCli(["up"], deps);
    expect(deps.registerHost).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "api-key" }),
      expect.anything(),
    );
    expect(deps.credentials.get).not.toHaveBeenCalled();
  });

  it("`register-url` uses the stored API key", async () => {
    const { deps } = harness({
      AMIKA_HOSTD_HOSTNAME: "builder",
      AMIKA_HOSTD_SECRET_KEY: SECRET,
    });
    deps.credentials.value = "amk_stored";
    expect(await runCli(["register-url", "https://x.example"], deps)).toBe(0);
    expect(deps.setHostUrl.mock.calls[0][0]).toMatchObject({
      apiKey: "amk_stored",
    });
  });

  it("the background daemon never gets the stored API key", async () => {
    const { deps } = unconfigured([""], ["amk_123"]);
    await runCli(["up"], deps);
    const env = deps.startInBackground.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { env: NodeJS.ProcessEnv },
    ];
    expect(Object.values(env[2].env)).not.toContain("amk_123");
  });
});
