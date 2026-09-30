import { describe, it, expect, vi } from "vitest";
import { AmikaClient } from "@/index";
import { mockFetch } from "./helpers.js";

const BASE = "https://api.example.com";

function makeClient(fetchImpl: typeof fetch): AmikaClient {
  return new AmikaClient({
    baseUrl: BASE,
    accessToken: "tok",
    fetch: fetchImpl,
  });
}

describe("AmikaClient.listRigs", () => {
  it("GETs /rigs and maps repo_url → repoUrl", async () => {
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
    const rigs = await client.listRigs();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs`);
    expect(rigs).toHaveLength(1);
    expect(rigs[0]?.repoUrl).toBe("git@github.com:org/a.git");
  });
});

describe("AmikaClient.createRig", () => {
  it("translates camelCase input to snake_case wire and parses response", async () => {
    const { fetch, calls } = mockFetch([
      {
        status: 202,
        body: { id: "1", name: "dev", state: "initializing", repo_url: "" },
      },
    ]);
    const client = makeClient(fetch);
    const rig = await client.createRig({
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
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs`);
    expect(body).toMatchObject({
      name: "dev",
      repo_url: "git@github.com:org/proj.git",
      env_vars: { FOO: "bar" },
      secret_env_vars: { TOKEN: "remote_secret" },
      setup_script_text: "#!/bin/bash\necho hi\n",
      new_branch_name: "feature/x",
      agent_credentials: [{ kind: "claude", name: "personal" }],
    });
    expect(rig.state).toBe("initializing");
  });

  it("omits undefined fields from the wire body", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev" } },
    ]);
    const client = makeClient(fetch);
    await client.createRig({ name: "dev" });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(Object.keys(body)).toEqual(["name"]);
  });

  it("forks from a snapshot when `snapshot` is a slug", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev" } },
    ]);
    const client = makeClient(fetch);
    await client.createRig({ name: "dev", snapshot: "amika-mono-base" });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(body.snapshot).toBe("amika-mono-base");
  });

  it("sends an explicit null snapshot to opt out of the default", async () => {
    const { fetch, calls } = mockFetch([
      { status: 202, body: { id: "1", name: "dev" } },
    ]);
    const client = makeClient(fetch);
    await client.createRig({ name: "dev", snapshot: null });
    const body = JSON.parse(calls[0]?.body ?? "");
    expect(Object.keys(body)).toEqual(["name", "snapshot"]);
    expect(body.snapshot).toBeNull();
  });
});

describe("AmikaClient rig lifecycle", () => {
  it("getRig URL-encodes the name", async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { name: "org/proj" } },
    ]);
    const client = makeClient(fetch);
    await client.getRig("org/proj");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/org%2Fproj`);
  });

  it("startRig POSTs to /start", async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: "" }]);
    const client = makeClient(fetch);
    await client.startRig("dev");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/dev/start`);
  });

  it("stopRig POSTs to /stop", async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: "" }]);
    const client = makeClient(fetch);
    await client.stopRig("dev");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/dev/stop`);
  });

  it("deleteRig DELETEs the rig", async () => {
    const { fetch, calls } = mockFetch([{ status: 204, body: "" }]);
    const client = makeClient(fetch);
    await client.deleteRig("dev");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/api/v0beta1/rigs/dev`);
  });
});

describe("AmikaClient.waitForRig", () => {
  it("polls every 3 seconds until state is ready", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "initializing" } },
        { status: 200, body: { name: "dev", state: "initializing" } },
        { status: 200, body: { name: "dev", state: "active" } },
      ]);
      const client = makeClient(fetch);
      const promise = client.waitForRig("dev");

      // Drain three poll cycles: each iteration awaits getRig, then sleeps 3s.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);

      const rig = await promise;
      expect(rig.state).toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the rig enters 'failed' state", async () => {
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
    await expect(client.waitForRig("dev")).rejects.toThrow(/out of capacity/);
  });

  it("waitForRigStop polls until 'stopped'", async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = mockFetch([
        { status: 200, body: { name: "dev", state: "stopping" } },
        { status: 200, body: { name: "dev", state: "stopped" } },
      ]);
      const client = makeClient(fetch);
      const promise = client.waitForRigStop("dev");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      const rig = await promise;
      expect(rig.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AmikaClient rig decoding", () => {
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
    const rig = await makeClient(fetch).getRig("dev");

    expect(rig.orgId).toBe("org_1");
    expect(rig.providerRigId).toBe("d_1");
    expect(rig.providerSandboxId).toBe("d_1");
    expect(rig.services[0]).toEqual({
      name: "web",
      url: "https://web.example",
      hostPort: 3000,
      containerPort: 3000,
      protocol: "tcp",
    });
    expect(rig.githubAuthMode).toBe("app");
    expect(rig.githubCredentialProvisioned).toBe(true);
    expect(rig.setupStatus).toBe("done");
    expect(rig.secretNames).toEqual(["API_KEY"]);
    expect(rig.mountedSecrets?.[0]).toEqual({
      name: "ANTHROPIC_API_KEY",
      scope: "user",
      managed: true,
      credentialType: "api_key",
      provider: "claude",
    });
    expect(rig).not.toHaveProperty("hasWorkflow");
    expect(rig.createdBy).toEqual({ name: "Jakub", email: null });
    expect(rig.origin).toBe("cli");
  });

  it("decodes preset and size under both the rig and sandbox names", async () => {
    const { fetch } = mockFetch([
      {
        status: 200,
        body: { name: "dev", sandbox_preset: "coder", sandbox_size: "large" },
      },
    ]);
    const rig = await makeClient(fetch).getRig("dev");
    expect(rig.rigPreset).toBe("coder");
    expect(rig.sandboxPreset).toBe("coder");
    expect(rig.rigSize).toBe("large");
    expect(rig.sandboxSize).toBe("large");
  });

  it("distinguishes a null nullable field from an absent optional one", async () => {
    const { fetch } = mockFetch([
      { status: 200, body: { id: "sbx_1", name: "dev", repo_url: null } },
    ]);
    const rig = await makeClient(fetch).getRig("dev");
    expect(rig.repoUrl).toBeNull();
    expect(rig.branch).toBeNull();
    expect(rig.services).toEqual([]);
    expect(rig.errorMessage).toBeUndefined();
    expect(rig.mountedSecrets).toBeUndefined();
    expect(rig).not.toHaveProperty("hasWorkflow");
  });

  it("sends github_auth_mode when createRig is given one", async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: { id: "1" } }]);
    await makeClient(fetch).createRig({ githubAuthMode: "app" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      github_auth_mode: "app",
    });
  });
});
