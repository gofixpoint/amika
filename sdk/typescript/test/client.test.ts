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
  it("listSecrets decodes the full summary", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: [
          {
            id: "1",
            org_id: "org_1",
            user_id: "usr_1",
            name: "API_KEY",
            description: null,
            scope: "user",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
        ],
      },
    ]);
    const client = makeClient(fetch);
    const secrets = await client.listSecrets();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets`);
    expect(secrets[0]).toEqual({
      id: "1",
      orgId: "org_1",
      userId: "usr_1",
      name: "API_KEY",
      description: null,
      scope: "user",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    });
  });

  it("listSecrets returns [] when the server sends no body", async () => {
    const { fetch } = mockFetch([{ status: 200, body: "" }]);
    expect(await makeClient(fetch).listSecrets()).toEqual([]);
  });

  it("createProviderSecret forwards an explicit scope", async () => {
    const { fetch, calls } = mockFetch([
      { status: 201, body: { id: "1", name: "work", scope: "org" } },
    ]);
    await makeClient(fetch).createProviderSecret("claude", {
      name: "work",
      value: "sk-…",
      type: "api_key",
      scope: "org",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "work",
      value: "sk-…",
      type: "api_key",
      scope: "org",
    });
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
    expect(resp).toEqual({
      result: "ok",
      sessionId: "s1",
      isError: false,
      isNewSession: false,
      agentSessionId: undefined,
      costUsd: undefined,
    });
  });

  it("decodes the optional accounting fields when the server sends them", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          response: "ok",
          session_id: "s1",
          is_error: false,
          is_new_session: true,
          agent_session_id: "as_1",
          cost_usd: 0.42,
        },
      },
    ]);
    const resp = await makeClient(fetch).agentSend("dev", { message: "hi" });
    expect(resp).toEqual({
      result: "ok",
      sessionId: "s1",
      isError: false,
      isNewSession: true,
      agentSessionId: "as_1",
      costUsd: 0.42,
    });
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
            { id: "s1", agent_name: "claude", preview: "fix the bug" },
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
    // `preview` is returned on list responses only.
    expect(sessions[0]?.preview).toBe("fix the bug");
    expect(sessions[1]?.preview).toBeUndefined();
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

  it("listSandboxSnapshots sends only the filters that are set", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    const client = makeClient(fetch);
    await client.listSandboxSnapshots({ repositoryId: "repo-1" });
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-snapshots?repository_id=repo-1`,
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

  it("getSandboxScrubPreview URL-encodes the sandbox ref", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { files: [], env_vars: [] } },
    ]);
    const client = makeClient(fetch);
    await client.getSandboxScrubPreview("org/dev");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-snapshots/scrub-preview?sandbox=org%2Fdev&by=ref`,
    );
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

describe("AmikaClient sandbox decoding", () => {
  it("keeps every field the API schema defines", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          id: "sbx_1",
          user_id: null,
          org_id: "org_1",
          name: "dev",
          provider: "daytona",
          provider_sandbox_id: "d_1",
          provider_url: null,
          amika_opencode_web: null,
          repo_name: "proj",
          repo_provider: "github",
          repo_id: "r_1",
          repo_url: "git@github.com:org/proj.git",
          branch: "main",
          commit_hash: null,
          snapshot: "proj-base",
          current_session_id: null,
          services: [
            {
              name: "web",
              url: "https://web.example",
              hostPort: 3000,
              containerPort: 3000,
              protocol: "tcp",
            },
          ],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:01:00Z",
          sandbox_preset: "coder",
          github_auth_mode: "app",
          github_credential_provisioned: true,
          state: "active",
          status: "ready",
          setup_status: "done",
          secret_names: ["API_KEY"],
          mounted_secrets: [
            {
              name: "ANTHROPIC_API_KEY",
              scope: "user",
              managed: true,
              credential_type: "api_key",
              provider: "claude",
            },
          ],
          has_workflow: true,
          created_by: { name: "Jakub", email: null },
          origin: "cli",
        },
      },
    ]);
    const sb = await makeClient(fetch).getSandbox("dev");

    expect(sb.orgId).toBe("org_1");
    expect(sb.providerSandboxId).toBe("d_1");
    expect(sb.services[0]).toEqual({
      name: "web",
      url: "https://web.example",
      hostPort: 3000,
      containerPort: 3000,
      protocol: "tcp",
    });
    expect(sb.githubAuthMode).toBe("app");
    expect(sb.githubCredentialProvisioned).toBe(true);
    expect(sb.setupStatus).toBe("done");
    expect(sb.secretNames).toEqual(["API_KEY"]);
    expect(sb.mountedSecrets?.[0]).toEqual({
      name: "ANTHROPIC_API_KEY",
      scope: "user",
      managed: true,
      credentialType: "api_key",
      provider: "claude",
    });
    expect(sb.hasWorkflow).toBe(true);
    expect(sb.createdBy).toEqual({ name: "Jakub", email: null });
    expect(sb.origin).toBe("cli");
  });

  it("distinguishes a null nullable field from an absent optional one", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { id: "sbx_1", name: "dev", repo_url: null } },
    ]);
    const sb = await makeClient(fetch).getSandbox("dev");
    expect(sb.repoUrl).toBeNull();
    expect(sb.branch).toBeNull();
    expect(sb.services).toEqual([]);
    expect(sb.errorMessage).toBeUndefined();
    expect(sb.mountedSecrets).toBeUndefined();
    expect(sb.hasWorkflow).toBe(false);
  });

  it("sends github_auth_mode when createSandbox is given one", async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: { id: "1" } }]);
    await makeClient(fetch).createSandbox({ githubAuthMode: "app" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      github_auth_mode: "app",
    });
  });
});

describe("AmikaClient.listRepositories", () => {
  it("GETs /repositories and maps repo_url", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: [{ id: "r_1", repo_url: "git@github.com:o/p.git" }],
      },
    ]);
    const repos = await makeClient(fetch).listRepositories();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/repositories`);
    expect(repos).toEqual([{ id: "r_1", repoUrl: "git@github.com:o/p.git" }]);
  });

  it("returns [] when the server sends no body", async () => {
    const { fetch } = mockFetch([{ status: 200, body: "" }]);
    expect(await makeClient(fetch).listRepositories()).toEqual([]);
  });
});

describe("AmikaClient snapshot fetch and wait", () => {
  it("getSandboxSnapshot resolves by ref and decodes every field", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: {
          id: "snap_1",
          snapshot: "proj-base",
          provider: "daytona",
          description: null,
          source_sandbox_id: "sbx_1",
          source_sandbox_name: "dev",
          repository_id: "r_1",
          repository_url: "git@github.com:o/p.git",
          base_snapshot: null,
          sandbox_preset: "coder",
          sandbox_size: null,
          capture_mode: "scrub_and_delete",
          state: "active",
          error_message: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:01:00Z",
          daytona: { name: "amika-proj-base", state: "active", cpu: 2 },
        },
      },
    ]);
    const snap = await makeClient(fetch).getSandboxSnapshot("org/proj-base");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-snapshots/org%2Fproj-base?by=ref`,
    );
    expect(snap.id).toBe("snap_1");
    expect(snap.repositoryUrl).toBe("git@github.com:o/p.git");
    expect(snap.captureMode).toBe("scrub_and_delete");
    expect(snap.daytona).toEqual({
      name: "amika-proj-base",
      state: "active",
      imageName: undefined,
      cpu: 2,
      memory: undefined,
      disk: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });
  });

  it("leaves daytona null when the provider sends none", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { snapshot: "s", state: "active" } },
    ]);
    const snap = await makeClient(fetch).getSandboxSnapshot("s");
    expect(snap.daytona).toBeNull();
  });

  it("getSandboxScrubPreview decodes restored_files", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          files: ["/home/amika/.claude/.credentials.json"],
          restored_files: ["/home/amika/.gitconfig"],
          env_vars: ["ANTHROPIC_API_KEY"],
        },
      },
    ]);
    const preview = await makeClient(fetch).getSandboxScrubPreview("dev");
    expect(preview.restoredFiles).toEqual(["/home/amika/.gitconfig"]);
  });

  it("waitForSandboxSnapshot polls every 3 seconds until active", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { snapshot: "s", state: "capturing" } },
        { status: 200, body: { snapshot: "s", state: "capturing" } },
        { status: 200, body: { snapshot: "s", state: "active" } },
      ]);
      const promise = makeClient(fetch).waitForSandboxSnapshot("s");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      expect((await promise).state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitForSandboxSnapshot throws the server's message on failure", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: { snapshot: "s", state: "failed", error_message: "disk full" },
      },
    ]);
    await expect(makeClient(fetch).waitForSandboxSnapshot("s")).rejects.toThrow(
      /disk full/,
    );
  });

  it("waitForSandboxSnapshot falls back to a generic message", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { snapshot: "s", state: "failed" } },
    ]);
    await expect(makeClient(fetch).waitForSandboxSnapshot("s")).rejects.toThrow(
      /sandbox snapshot capture failed/,
    );
  });
});

describe("AmikaClient sandbox services", () => {
  const wireService = {
    id: "svc_1",
    sandbox_id: "sbx_1",
    name: "web",
    port: 3000,
    url_scheme: "https",
    protocol: "tcp",
    url: "https://web.example",
    host_port: 3000,
    source: "table",
    kind: "user",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("listSandboxServices unwraps {items} and filters by sandbox_ref", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { items: [wireService] } },
    ]);
    const services = await makeClient(fetch).listSandboxServices("org/dev");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandbox-services?sandbox_ref=org%2Fdev`,
    );
    expect(services[0]?.urlScheme).toBe("https");
    expect(services[0]?.hostPort).toBe(3000);
  });

  it("listSandboxServices omits the filter when no ref is given", async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [] } }]);
    await makeClient(fetch).listSandboxServices();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/sandbox-services`);
  });

  it("keeps a legacy service's null url and id", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              ...wireService,
              id: null,
              url: null,
              url_scheme: null,
              host_port: null,
            },
          ],
        },
      },
    ]);
    const services = await makeClient(fetch).listSandboxServices();
    expect(services[0]?.id).toBeNull();
    expect(services[0]?.url).toBeNull();
    expect(services[0]?.urlScheme).toBeNull();
    expect(services[0]?.hostPort).toBeNull();
  });

  it("createSandboxService POSTs url_scheme in snake_case", async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: wireService }]);
    const svc = await makeClient(fetch).createSandboxService("org/dev", {
      name: "web",
      port: 3000,
      urlScheme: "https",
    });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandboxes/org%2Fdev/services`,
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "web",
      port: 3000,
      url_scheme: "https",
    });
    expect(svc.name).toBe("web");
  });

  it("putSandboxService resolves by name unless told otherwise", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: wireService },
      { status: 200, body: wireService },
    ]);
    const client = makeClient(fetch);
    const req = { name: "web", port: 3001, urlScheme: "http" as const };
    await client.putSandboxService("dev", "web", req);
    await client.putSandboxService("dev", "svc_1", req, "id");
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandboxes/dev/services/web?by=name`,
    );
    expect(calls[1]?.url).toBe(
      `${BASE}/api/v0beta1/sandboxes/dev/services/svc_1?by=id`,
    );
  });

  it("deleteSandboxService DELETEs by name", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    await makeClient(fetch).deleteSandboxService("dev", "web");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandboxes/dev/services/web?by=name`,
    );
  });
});

describe("sandbox service port validation", () => {
  // Mirrors go/internal/services.TestValidatePort so the two stay in step.
  it.each([3000, 1, 65535, 60898, 61000])("accepts port %i", async (port) => {
    const { fetch, calls } = mockFetch([{ status: 201, body: {} }]);
    await makeClient(fetch).createSandboxService("dev", {
      name: "web",
      port,
      urlScheme: "http",
    });
    expect(JSON.parse(calls[0]?.body ?? "").port).toBe(port);
  });

  it.each([
    [0, /must be between 1 and 65535/],
    [-1, /must be between 1 and 65535/],
    [70000, /must be between 1 and 65535/],
    [3000.5, /must be between 1 and 65535/],
    [60899, /reserved for internal Amika services/],
    [60999, /reserved for internal Amika services/],
    [60950, /reserved for internal Amika services/],
  ])("rejects port %i without issuing a request", async (port, message) => {
    const { fetch, calls } = mockFetch([]);
    const client = makeClient(fetch);
    const req = { name: "web", port, urlScheme: "http" as const };
    await expect(client.createSandboxService("dev", req)).rejects.toThrow(
      message,
    );
    await expect(client.putSandboxService("dev", "web", req)).rejects.toThrow(
      message,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("AmikaClient SSH public keys", () => {
  const ED25519_KEY =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4ilkUClOhQyh1hQBSn7N/cMSpX0oqg4P87b21Qqdvt";

  it("createSSHPublicKey POSTs public_key in snake_case", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 201,
        body: {
          id: "k_1",
          name: "laptop",
          public_key: ED25519_KEY,
          scope: "user",
        },
      },
    ]);
    const summary = await makeClient(fetch).createSSHPublicKey({
      name: "laptop",
      publicKey: ED25519_KEY,
    });
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/ssh-public-keys`);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      name: "laptop",
      public_key: ED25519_KEY,
    });
    expect(summary.publicKey).toBe(ED25519_KEY);
  });

  it("listSSHPublicKeys maps each summary", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 200,
        body: [
          { id: "k_1", name: "laptop", public_key: ED25519_KEY, scope: "user" },
        ],
      },
    ]);
    const keys = await makeClient(fetch).listSSHPublicKeys();
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/secrets/ssh-public-keys`);
    expect(keys[0]?.name).toBe("laptop");
  });

  it("deleteSSHPublicKey URL-encodes the id", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    await makeClient(fetch).deleteSSHPublicKey("k/1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/secrets/ssh-public-keys/k%2F1`,
    );
  });
});

describe("AmikaClient.createSSHSession", () => {
  const validDescriptor = {
    session_id: "sshs_abc",
    transport: "direct_ws",
    connect_url: "wss://relay.example.com/v1/ssh-sessions",
    connect_credential: "A".repeat(42) + "Q",
    sandbox_id: "sbx_1",
    ssh_user: "amika",
    host_public_key:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4ilkUClOhQyh1hQBSn7N/cMSpX0oqg4P87b21Qqdvt",
  };

  it("POSTs to /ssh-sessions and returns the validated descriptor", async () => {
    const { fetch, calls } = mockFetch([
      { status: 201, body: validDescriptor },
    ]);
    const session = await makeClient(fetch).createSSHSession("sbx_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      `${BASE}/api/v0beta1/sandboxes/sbx_1/ssh-sessions`,
    );
    expect(session.sessionId).toBe("sshs_abc");
    expect(session.transport).toBe("direct_ws");
  });

  it("rejects a descriptor issued for another sandbox", async () => {
    const { fetch } = mockFetch([{ status: 201, body: validDescriptor }]);
    await expect(makeClient(fetch).createSSHSession("sbx_2")).rejects.toThrow(
      /invalid SSH session descriptor/,
    );
  });

  it("rejects a descriptor with a non-wss connect URL", async () => {
    const { fetch } = mockFetch([
      {
        status: 201,
        body: {
          ...validDescriptor,
          connect_url: "ws://relay.example.com/v1/ssh-sessions",
        },
      },
    ]);
    await expect(makeClient(fetch).createSSHSession("sbx_1")).rejects.toThrow(
      /invalid SSH session descriptor/,
    );
  });
});
