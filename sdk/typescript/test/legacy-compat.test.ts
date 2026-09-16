// Guards the compatibility promise in the README: an object literal written
// against the pre-rig (0.11) type surface must still type-check against the
// sandbox-named aliases. These fixtures carry only the fields that release
// required, so adding a required rig-spelled mirror to any of these types
// breaks this file at `pnpm typecheck` rather than in a consumer's build.
//
// The runtime assertions are incidental; the compile is the test.

import { describe, expect, it } from "vitest";

import type { AmikaClient } from "@/client";
import type {
  AgentSessionSendResponse,
  AgentSessionSummary,
} from "@/agent-sessions";
import type {
  CreateSandboxSnapshotRequest,
  RemoteSandbox,
  SandboxServiceResource,
  SandboxSnapshot,
  Session,
} from "@/types";

const sandbox: RemoteSandbox = {
  id: "sbx_1",
  userId: null,
  orgId: "org_1",
  name: "dev",
  provider: null,
  providerSandboxId: null,
  providerUrl: null,
  amikaOpencodeWeb: null,
  repoName: null,
  repoProvider: null,
  repoId: null,
  repoUrl: null,
  branch: null,
  commitHash: null,
  snapshot: null,
  currentSessionId: null,
  services: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  state: "active",
  status: "ready",
  hasWorkflow: false,
};

const session: Session = {
  id: "s1",
  sandboxId: "sbx_1",
  orgId: "org_1",
  agentName: "claude",
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  metadata: {},
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const service: SandboxServiceResource = {
  id: "svc_1",
  sandboxId: "sbx_1",
  name: "web",
  port: 3000,
  urlScheme: "https",
  protocol: "tcp",
  url: null,
  hostPort: null,
  source: "table",
  kind: "user",
  createdAt: null,
  updatedAt: null,
};

const snapshot: SandboxSnapshot = {
  id: "snap_1",
  snapshot: "proj-base",
  provider: "daytona",
  description: null,
  sourceSandboxId: null,
  sourceSandboxName: null,
  repositoryId: null,
  repositoryUrl: null,
  baseSnapshot: null,
  sandboxPreset: null,
  sandboxSize: null,
  captureMode: null,
  state: "active",
  errorMessage: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  daytona: null,
};

const sendResponse: AgentSessionSendResponse = {
  sessionId: "as_1",
  sandboxId: "sbx_1",
  agent: "claude",
  response: "hi",
  isError: false,
  isNewSession: true,
  createdSandbox: false,
};

const summary: AgentSessionSummary = {
  sessionId: "as_1",
  sandboxId: "sbx_1",
  sandboxName: null,
  agent: "claude",
  status: "running",
  preview: null,
  model: null,
  effort: null,
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const captureRequest: CreateSandboxSnapshotRequest = {
  sandboxRef: "dev",
  name: "my-snap",
};

/**
 * `sandboxRef` was a required `string` in 0.11, so reading it must still give a
 * `string` rather than `string | undefined`. Declaring the return type is the
 * assertion: aliasing the legacy request to the rig union widens this and fails
 * to compile here.
 */
function readsSandboxRef(req: CreateSandboxSnapshotRequest): string {
  return req.sandboxRef;
}

describe("pre-rig literals still satisfy the sandbox-named types", () => {
  it("accepts fixtures carrying no rig-spelled field", () => {
    expect([
      sandbox,
      session,
      service,
      snapshot,
      sendResponse,
      summary,
      captureRequest,
    ]).toHaveLength(7);
  });

  it("keeps sandboxRef readable as a plain string", () => {
    expect(readsSandboxRef(captureRequest)).toBe("dev");
  });

  it("still admits a value the SDK decodes, which carries both spellings", () => {
    // A rig-shaped value flows into the legacy alias; the reverse does not, and
    // is not promised.
    const withRigFields: RemoteSandbox = { ...sandbox, providerRigId: null };
    expect(withRigFields.providerRigId).toBeNull();
  });

  // The deprecated methods are declared with the legacy types for this reason:
  // a stand-in built from these fixtures has to satisfy the real method
  // signature, and a relaxed legacy shape is not assignable to the strict rig
  // type. Declaring them with `Rig*` return types would break this.
  it("lets a hand-built stand-in satisfy the deprecated method signatures", async () => {
    const stub: Pick<
      AmikaClient,
      "listSandboxes" | "getSandbox" | "listSandboxSnapshots"
    > = {
      listSandboxes: () => Promise.resolve([sandbox]),
      getSandbox: () => Promise.resolve(sandbox),
      listSandboxSnapshots: () => Promise.resolve([snapshot]),
    };

    expect(await stub.listSandboxes()).toHaveLength(1);
    expect((await stub.getSandbox("dev")).name).toBe("dev");
    expect(await stub.listSandboxSnapshots()).toHaveLength(1);
  });
});
