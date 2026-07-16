import { describe, it, expect, vi } from "vitest";

import { AmikaClient } from "@/client";
import { AmikaError, AmikaHTTPError } from "@/errors";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

describe("AmikaClient construction", () => {
  it("requires accessToken or tokenSource", () => {
    expect(() => new AmikaClient({ baseUrl: BASE })).toThrow(
      /accessToken or tokenSource is required/,
    );
  });

  it("rejects both accessToken and tokenSource", () => {
    expect(
      () =>
        new AmikaClient({
          baseUrl: BASE,
          accessToken: "tok",
          tokenSource: { token: () => "other" },
        }),
    ).toThrow(/not both/);
  });
});

describe("AmikaClient.listSandboxes", () => {
  it("GETs /sandboxes and maps repo_url → repoUrl", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: [
          {
            id: "1",
            name: "a",
            repo_url: "git@github.com:org/a.git",
            state: "active",
          },
        ],
      },
    ]);
    const client = makeClient(fetch);
    const sandboxes = await client.listSandboxes();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes`);
    expect(sandboxes).toHaveLength(1);
    expect(sandboxes[0]?.repoUrl).toBe("git@github.com:org/a.git");
  });
});

describe("AmikaClient.createSandbox", () => {
  it("translates camelCase input to snake_case wire and parses response", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 202,
        body: { id: "1", name: "dev", state: "initializing", repo_url: "" },
      },
    ]);
    const client = makeClient(fetch);
    const sb = await client.createSandbox({
      name: "dev",
      repoUrl: "git@github.com:org/proj.git",
      envVars: { FOO: "bar" },
      secretEnvVars: { TOKEN: "remote_secret" },
      setupScriptText: "#!/bin/bash\necho hi\n",
      newBranchName: "feature/x",
      agentCredentials: [{ kind: "claude", name: "personal" }],
    });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(calls[0]?.method).toBe("POST");
    expect(body).toMatchObject({
      name: "dev",
      repo_url: "git@github.com:org/proj.git",
      env_vars: { FOO: "bar" },
      secret_env_vars: { TOKEN: "remote_secret" },
      setup_script_text: "#!/bin/bash\necho hi\n",
      new_branch_name: "feature/x",
      agent_credentials: [{ kind: "claude", name: "personal" }],
    });
    expect(sb.state).toBe("initializing");
  });

  it("omits undefined fields from the wire body", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev" } },
    ]);
    const client = makeClient(fetch);
    await client.createSandbox({ name: "dev" });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(Object.keys(body)).toEqual(["name"]);
  });

  it("forks from a snapshot when `snapshot` is a slug", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev" } },
    ]);
    const client = makeClient(fetch);
    await client.createSandbox({ name: "dev", snapshot: "amika-mono-base" });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.snapshot).toBe("amika-mono-base");
  });

  it("sends an explicit null snapshot to opt out of the default", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev" } },
    ]);
    const client = makeClient(fetch);
    await client.createSandbox({ name: "dev", snapshot: null });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(Object.keys(body)).toEqual(["name", "snapshot"]);
    expect(body.snapshot).toBeNull();
  });
});

describe("AmikaClient sandbox lifecycle", () => {
  it("getSandbox URL-encodes the name", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { name: "org/proj" } },
    ]);
    const client = makeClient(fetch);
    await client.getSandbox("org/proj");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes/org%2Fproj`);
  });

  it("startSandbox POSTs to /start", async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: "" }]);
    const client = makeClient(fetch);
    await client.startSandbox("dev");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes/dev/start`);
  });

  it("stopSandbox POSTs to /stop", async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: "" }]);
    const client = makeClient(fetch);
    await client.stopSandbox("dev");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes/dev/stop`);
  });

  it("deleteSandbox DELETEs the sandbox", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.deleteSandbox("dev");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes/dev`);
  });

  it("getSSH POSTs to /ssh and maps fields", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          ssh_destination: "user@host",
          token: "t",
          expires_at: "2026-01-01T00:00:00Z",
          repo_name: "proj",
        },
      },
    ]);
    const client = makeClient(fetch);
    const info = await client.getSSH("dev");
    expect(calls[0]?.method).toBe("POST");
    expect(info.sshDestination).toBe("user@host");
    expect(info.repoName).toBe("proj");
  });

  it("revokeSSH DELETEs with token in body", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.revokeSSH("dev", "tok-xyz");
    expect(calls[0]?.method).toBe("DELETE");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ token: "tok-xyz" });
  });
});

describe("AmikaClient.waitForSandbox", () => {
  it("polls every 3 seconds until state is ready", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "initializing" } },
        { status: 200, body: { name: "dev", state: "initializing" } },
        { status: 200, body: { name: "dev", state: "active" } },
      ]);
      const client = makeClient(fetch);
      const promise = client.waitForSandbox("dev");

      // Drain three poll cycles: each iteration awaits getSandbox, then sleeps 3s.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);

      const sb = await promise;
      expect(sb.state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the sandbox enters 'failed' state", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          name: "dev",
          state: "failed",
          error_message: "out of capacity",
        },
      },
    ]);
    const client = makeClient(fetch);
    await expect(client.waitForSandbox("dev")).rejects.toThrow(
      /out of capacity/,
    );
  });

  it("waitForSandboxStop polls until 'stopped'", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "stopping" } },
        { status: 200, body: { name: "dev", state: "stopped" } },
      ]);
      const client = makeClient(fetch);
      const promise = client.waitForSandboxStop("dev");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      const sb = await promise;
      expect(sb.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AmikaClient secrets", () => {
  it("listSecrets returns the array as-is", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: [{ id: "1", name: "API_KEY", scope: "user" }] },
    ]);
    const client = makeClient(fetch);
    const secrets = await client.listSecrets();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets`);
    expect(secrets[0]?.name).toBe("API_KEY");
  });

  it("createSecret POSTs the request body", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: "" }]);
    const client = makeClient(fetch);
    await client.createSecret({ name: "API_KEY", value: "v", scope: "user" });
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "API_KEY",
      value: "v",
      scope: "user",
    });
  });

  it("updateSecret PUTs to /secrets/{id}", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.updateSecret("abc", { value: "newval" });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/abc`);
  });

  it("createProviderSecret POSTs to /secrets/{provider}", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { id: "1", name: "personal", scope: "user" } },
    ]);
    const client = makeClient(fetch);
    const summary = await client.createProviderSecret("claude", {
      name: "personal",
      value: "v",
      type: "oauth",
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/claude`);
    expect(summary.name).toBe("personal");
  });

  it("deleteProviderSecret hits /secrets/{provider}/{id}", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.deleteProviderSecret("claude", "abc");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/claude/abc`);
  });
});

describe("AmikaClient.agentSend", () => {
  it("maps response.response → result and includes new_session/session_id in wire body", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: { response: "ok", session_id: "s1", is_error: false },
      },
    ]);
    const client = makeClient(fetch);
    const resp = await client.agentSend("dev", {
      message: "do it",
      newSession: true,
      sessionId: "s1",
      agent: "claude",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      message: "do it",
      new_session: true,
      session_id: "s1",
      agent: "claude",
    });
    expect(resp).toEqual({ result: "ok", sessionId: "s1", isError: false });
  });

  it("rewrites agent auth-error HTTP failures to a friendly AmikaError", async () => {
    const inner = {
      is_error: true,
      result: "authentication_error: invalid x-api-key",
    };
    const envelope = { error: "agent failed", details: JSON.stringify(inner) };
    const { fetch } = mockFetch([{ status: 500, body: envelope }]);
    const client = makeClient(fetch);
    const err = await client
      .agentSend("dev", { message: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmikaError);
    expect(err).not.toBeInstanceOf(AmikaHTTPError);
    expect((err as Error).message).toMatch(/authentication_error/);
  });
});

describe("AmikaClient sessions", () => {
  it("createSession POSTs camelCase → snake_case", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 201,
        body: {
          id: "s1",
          agent_name: "claude",
          started_at: "2026-01-01T00:00:00Z",
        },
      },
    ]);
    const client = makeClient(fetch);
    const sess = await client.createSession("dev", {
      agentName: "claude",
      metadata: { intent: "test" },
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      agent_name: "claude",
      metadata: { intent: "test" },
    });
    expect(sess.agentName).toBe("claude");
  });

  it("listSessions unwraps the {sessions, total} envelope", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          sessions: [
            { id: "s1", agent_name: "claude" },
            { id: "s2", agent_name: "codex" },
          ],
          total: 2,
        },
      },
    ]);
    const client = makeClient(fetch);
    const sessions = await client.listSessions("dev");
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.agentName).toBe("codex");
  });

  it("getLatestSession returns null on 404", async () => {
    const { fetch } = mockFetch([
      { status: 404, body: { message: "no sessions" } },
    ]);
    const client = makeClient(fetch);
    expect(await client.getLatestSession("dev")).toBeNull();
  });

  it("getLatestSession rethrows non-404 errors", async () => {
    const { fetch } = mockFetch([{ status: 500, body: { message: "boom" } }]);
    const client = makeClient(fetch);
    await expect(client.getLatestSession("dev")).rejects.toBeInstanceOf(
      AmikaHTTPError,
    );
  });

  it("updateSession PATCHes to /sessions/{id}", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: { id: "s1", status: "completed", agent_name: "claude" },
      },
    ]);
    const client = makeClient(fetch);
    await client.updateSession("dev", "s1", { status: "completed" });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandboxes/dev/sessions/s1`);
  });
});

describe("AmikaClient sandbox snapshots", () => {
  it("listSandboxSnapshots GETs /sandbox-snapshots and unwraps {items} + maps fields", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              snapshot: "amika-mono-base",
              provider: "daytona",
              state: "active",
              source_sandbox_name: "dev",
              base_snapshot: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:05:00Z",
            },
          ],
        },
      },
    ]);
    const client = makeClient(fetch);
    const snapshots = await client.listSandboxSnapshots();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandbox-snapshots`);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.snapshot).toBe("amika-mono-base");
    expect(snapshots[0]?.sourceSandboxName).toBe("dev");
    expect(snapshots[0]?.baseSnapshot).toBeNull();
  });

  it("listSandboxSnapshots encodes repository/source filters as query params", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    const client = makeClient(fetch);
    await client.listSandboxSnapshots({
      repositoryId: "repo-1",
      sourceSandboxId: "sbx-2",
    });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-snapshots?repository_id=repo-1&source_sandbox_id=sbx-2`,
    );
  });

  it("returns an empty list when the envelope has no items", async () => {
    const { fetch } = mockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);
    expect(await client.listSandboxSnapshots()).toEqual([]);
  });

  it("createSandboxSnapshot POSTs camelCase → snake_case and parses response", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 202,
        body: { snapshot: "my-snap", provider: "daytona", state: "capturing" },
      },
    ]);
    const client = makeClient(fetch);
    const snap = await client.createSandboxSnapshot({
      sandboxRef: "dev",
      name: "my-snap",
      description: "before refactor",
      mode: "full",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandbox-snapshots`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      sandbox_ref: "dev",
      name: "my-snap",
      description: "before refactor",
      mode: "full",
    });
    expect(snap.state).toBe("capturing");
  });

  it("createSandboxSnapshot omits optional fields when not given", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { snapshot: "my-snap" } },
    ]);
    const client = makeClient(fetch);
    await client.createSandboxSnapshot({ sandboxRef: "dev", name: "my-snap" });
    expect(Object.keys(JSON.parse(calls[0]?.body ?? ""))).toEqual([
      "sandbox_ref",
      "name",
    ]);
  });

  it("getSandboxScrubPreview GETs scrub-preview with sandbox+by params and maps env_vars", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: { files: ["/root/.claude/.credentials.json"], env_vars: ["FOO"] },
      },
    ]);
    const client = makeClient(fetch);
    const preview = await client.getSandboxScrubPreview("dev");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-snapshots/scrub-preview?sandbox=dev&by=ref`,
    );
    expect(preview.files).toEqual(["/root/.claude/.credentials.json"]);
    expect(preview.envVars).toEqual(["FOO"]);
  });

  it("deleteSandboxSnapshot DELETEs by ref, URL-encoding the reference", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.deleteSandboxSnapshot("org/my-snap");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-snapshots/org%2Fmy-snap?by=ref`,
    );
  });
});
