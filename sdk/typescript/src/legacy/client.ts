import { type Rigs, type Rig, type Sandbox } from "../rigs/rig.js";
import {
  type AgentSessions,
  type AgentSendRequest,
  type AgentSendResponse,
  type AgentSessionSendRequest,
  type AgentSessionSendResponse,
  type AgentSessionStreamHandlers,
  type ListAgentSessionsResponse,
  type AgentSessionDetail,
} from "../agent-sessions/types.js";
import {
  type Snapshots,
  type ListRigSnapshotsOptions,
} from "../snapshots/snapshot.js";
import {
  type Services,
  type RigServiceResource,
  type RigServiceRequest,
  type SandboxServiceResource,
  type SandboxServiceRequest,
} from "../services/types.js";
import {
  type Secrets,
  type Secret,
  type CreateSecretRequest,
  type UpdateSecretRequest,
} from "../secrets/types.js";
import {
  type AgentCredentials,
  type CreateProviderSecretRequest,
  type ProviderSecretSummary,
  type ProviderSecretListItem,
} from "../agent-credentials/types.js";
import {
  type RigSessions,
  type CreateSessionRequest,
  type Session,
  type UpdateSessionRequest,
} from "../rig-sessions/types.js";
import {
  type Repositories,
  type RemoteRepository,
} from "../repositories/types.js";
import {
  type CreateRigRequest,
  type RemoteRig,
  type CreateSandboxRequest,
  type RemoteSandbox,
} from "../rigs/types.js";
import { AmikaError } from "../errors.js";
import {
  type RigSnapshot,
  type CreateRigSnapshotRequest,
  type RigScrubPreview,
  type SandboxSnapshot,
  type CreateSandboxSnapshotRequest,
  type SandboxScrubPreview,
} from "../snapshots/types.js";

import { waitForRigState } from "./wait.js";
import { sleep } from "../internal/polling.js";
const WAIT_POLL_INTERVAL_MS = 3_000;

/** Compatibility forwarding methods. Prefer the grouped AmikaClient API. */
export abstract class LegacyClient {
  abstract readonly rigs: Rigs;
  abstract readonly agentSessions: AgentSessions;
  abstract readonly snapshots: Snapshots;
  abstract readonly services: Services;
  abstract readonly secrets: Secrets;
  abstract readonly agentCredentials: AgentCredentials;
  abstract readonly rigSessions: RigSessions;
  abstract readonly repositories: Repositories;

  /** @deprecated Use client.rigs.list through the grouped API. */
  async listRigs(): Promise<Rig[]> {
    return this.rigs.list();
  }

  /** @deprecated Use client.rigs.create through the grouped API. */
  async createRig(req: CreateRigRequest): Promise<Rig> {
    return this.rigs.create(req);
  }

  /** @deprecated Use client.rigs.get through the grouped API. */
  async getRig(name: string): Promise<Rig> {
    return this.rigs.get(name);
  }

  /** @deprecated Use rig.wait(). This legacy helper checks state only and polls every 3 seconds without a total deadline. */
  waitForRig(name: string): Promise<RemoteRig> {
    return waitForRigState(
      (n) => this.getRig(n),
      name,
      ["active", "running", "started"],
      "rig provisioning failed",
    );
  }

  /** @deprecated Use client.rigs.handle(name).start(). */
  async startRig(name: string): Promise<void> {
    return this.rigs.handle(name).start();
  }

  /** @deprecated Use rig.wait(). This legacy helper checks state only and polls every 3 seconds without a total deadline. */
  waitForRigStart(name: string): Promise<RemoteRig> {
    return waitForRigState(
      (n) => this.getRig(n),
      name,
      ["active", "running", "started"],
      "rig start failed",
    );
  }

  /** @deprecated Use client.rigs.handle(name).stop(). */
  async stopRig(name: string): Promise<void> {
    return this.rigs.handle(name).stop();
  }

  /** @deprecated Use rig.wait(). This legacy helper checks state only and polls every 3 seconds without a total deadline. */
  waitForRigStop(name: string): Promise<RemoteRig> {
    return waitForRigState(
      (n) => this.getRig(n),
      name,
      ["stopped"],
      "rig stop failed",
    );
  }

  /** @deprecated Use client.rigs.handle(name).delete(). */
  async deleteRig(name: string): Promise<void> {
    return this.rigs.handle(name).delete();
  }

  /** @deprecated Use {@link Rigs.list}. */
  listSandboxes(): Promise<Sandbox[]> {
    return this.listRigs();
  }

  /** @deprecated Use {@link Rigs.create}. */
  createSandbox(req: CreateSandboxRequest): Promise<Sandbox> {
    return this.createRig(req);
  }

  /** @deprecated Use {@link Rigs.get}. */
  getSandbox(name: string): Promise<Sandbox> {
    return this.getRig(name);
  }

  /** @deprecated Use {@link Rig.wait}. */
  waitForSandbox(name: string): Promise<RemoteSandbox> {
    return this.waitForRig(name);
  }

  /** @deprecated Use {@link Rig.start}. */
  startSandbox(name: string): Promise<void> {
    return this.startRig(name);
  }

  /** @deprecated Use {@link Rig.wait}. */
  waitForSandboxStart(name: string): Promise<RemoteSandbox> {
    return this.waitForRigStart(name);
  }

  /** @deprecated Use {@link Rig.stop}. */
  stopSandbox(name: string): Promise<void> {
    return this.stopRig(name);
  }

  /** @deprecated Use {@link Rig.wait}. */
  waitForSandboxStop(name: string): Promise<RemoteSandbox> {
    return this.waitForRigStop(name);
  }

  /** @deprecated Use {@link Rig.delete}. */
  deleteSandbox(name: string): Promise<void> {
    return this.deleteRig(name);
  }

  /** @deprecated Use client.repositories.list through the grouped API. */
  async listRepositories(): Promise<RemoteRepository[]> {
    return this.repositories.list();
  }

  /** @deprecated Use client.services.list through the grouped API. */
  async listRigServices(rigRef?: string): Promise<RigServiceResource[]> {
    return this.services.list({ rigRef });
  }

  /** @deprecated Use client.services.create through the grouped API. */
  async createRigService(
    rigRef: string,
    req: RigServiceRequest,
  ): Promise<RigServiceResource> {
    return this.services.create(rigRef, req);
  }

  /** @deprecated Use client.services.replace through the grouped API. */
  async putRigService(
    rigRef: string,
    serviceRef: string,
    req: RigServiceRequest,
    by: "name" | "id" | "ref" = "name",
  ): Promise<RigServiceResource> {
    return this.services.replace(rigRef, serviceRef, req, by);
  }

  /** @deprecated Use client.services.delete through the grouped API. */
  async deleteRigService(rigRef: string, serviceRef: string): Promise<void> {
    return this.services.delete(rigRef, serviceRef);
  }

  /** @deprecated Use {@link Services.list}. */
  listSandboxServices(sandboxRef?: string): Promise<SandboxServiceResource[]> {
    return this.listRigServices(sandboxRef);
  }

  /** @deprecated Use {@link Services.create}. */
  createSandboxService(
    sandboxRef: string,
    req: SandboxServiceRequest,
  ): Promise<SandboxServiceResource> {
    return this.createRigService(sandboxRef, req);
  }

  /** @deprecated Use {@link Services.replace}. */
  putSandboxService(
    sandboxRef: string,
    serviceRef: string,
    req: SandboxServiceRequest,
    by: "name" | "id" | "ref" = "name",
  ): Promise<SandboxServiceResource> {
    return this.putRigService(sandboxRef, serviceRef, req, by);
  }

  /** @deprecated Use {@link Services.delete}. */
  deleteSandboxService(sandboxRef: string, serviceRef: string): Promise<void> {
    return this.deleteRigService(sandboxRef, serviceRef);
  }

  /** @deprecated Use client.secrets.list through the grouped API. */
  async listSecrets(): Promise<Secret[]> {
    return this.secrets.list();
  }

  /** @deprecated Use client.secrets.create through the grouped API. */
  async createSecret(req: CreateSecretRequest): Promise<void> {
    return this.secrets.create(req);
  }

  /** @deprecated Use client.secrets.update through the grouped API. */
  async updateSecret(id: string, req: UpdateSecretRequest): Promise<void> {
    return this.secrets.update(id, req);
  }

  /** @deprecated Use client.agentCredentials.create through the grouped API. */
  async createProviderSecret(
    provider: string,
    req: CreateProviderSecretRequest,
  ): Promise<ProviderSecretSummary> {
    return this.agentCredentials.create(provider, req);
  }

  /** @deprecated Use client.agentCredentials.list through the grouped API. */
  async listProviderSecrets(
    provider: string,
  ): Promise<ProviderSecretListItem[]> {
    return this.agentCredentials.list(provider);
  }

  /** @deprecated Use client.agentCredentials.delete through the grouped API. */
  async deleteProviderSecret(provider: string, id: string): Promise<void> {
    return this.agentCredentials.delete(provider, id);
  }

  /** @deprecated Use client.rigs.handle(name).send(request). */
  async agentSend(
    rigName: string,
    req: AgentSendRequest,
  ): Promise<AgentSendResponse> {
    if (rigName.trim() === "")
      throw new AmikaError("rig name must not be empty");
    return this.rigs.handle(rigName).send(req);
  }

  /** @deprecated Use client.rigSessions.create through the grouped API. */
  async createSession(
    rigName: string,
    req: CreateSessionRequest,
  ): Promise<Session> {
    return this.rigSessions.create(rigName, req);
  }

  /** @deprecated Use client.rigSessions.list through the grouped API. */
  async listSessions(rigName: string): Promise<Session[]> {
    return this.rigSessions.list(rigName);
  }

  /** @deprecated Use client.rigSessions.latest through the grouped API. */
  async getLatestSession(rigName: string): Promise<Session | null> {
    return this.rigSessions.latest(rigName);
  }

  /** @deprecated Use client.rigSessions.get through the grouped API. */
  async getSession(rigName: string, sessionId: string): Promise<Session> {
    return this.rigSessions.get(rigName, sessionId);
  }

  /** @deprecated Use client.rigSessions.update through the grouped API. */
  async updateSession(
    rigName: string,
    sessionId: string,
    req: UpdateSessionRequest,
  ): Promise<Session> {
    return this.rigSessions.update(rigName, sessionId, req);
  }

  /** @deprecated Use client.snapshots.list through the grouped API. */
  async listRigSnapshots(
    filters?: ListRigSnapshotsOptions,
  ): Promise<RigSnapshot[]> {
    return this.snapshots.list(filters);
  }

  /** @deprecated Use client.snapshots.create through the grouped API. */
  async createRigSnapshot(req: CreateRigSnapshotRequest): Promise<RigSnapshot> {
    return this.snapshots.create(req);
  }

  /** @deprecated Use client.snapshots.get through the grouped API. */
  async getRigSnapshot(ref: string): Promise<RigSnapshot> {
    return this.snapshots.get(ref);
  }

  /** @deprecated Use snapshot.wait(). This legacy helper polls every 3 seconds without a total deadline. */
  async waitForRigSnapshot(ref: string): Promise<RigSnapshot> {
    for (;;) {
      const snapshot = await this.getRigSnapshot(ref);
      if (snapshot.state === "active") return snapshot;
      if (snapshot.state === "failed") {
        throw new AmikaError(
          snapshot.errorMessage || "rig snapshot capture failed",
        );
      }
      await sleep(WAIT_POLL_INTERVAL_MS);
    }
  }

  /** @deprecated Use client.snapshots.previewScrub through the grouped API. */
  async getRigScrubPreview(rigRef: string): Promise<RigScrubPreview> {
    return this.snapshots.previewScrub(rigRef);
  }

  /** @deprecated Use client.snapshots.handle(ref).delete(). */
  async deleteRigSnapshot(ref: string): Promise<void> {
    return this.snapshots.handle(ref).delete();
  }

  /** @deprecated Use {@link Snapshots.list}. */
  listSandboxSnapshots(filters?: {
    repositoryId?: string;
    sourceSandboxId?: string;
  }): Promise<SandboxSnapshot[]> {
    return this.listRigSnapshots(filters);
  }

  /** @deprecated Use {@link Snapshots.create}. */
  createSandboxSnapshot(
    req: CreateSandboxSnapshotRequest,
  ): Promise<SandboxSnapshot> {
    return this.createRigSnapshot(req);
  }

  /** @deprecated Use {@link Snapshots.get}. */
  getSandboxSnapshot(ref: string): Promise<SandboxSnapshot> {
    return this.getRigSnapshot(ref);
  }

  /** @deprecated Use {@link Snapshots.handle}. */
  waitForSandboxSnapshot(ref: string): Promise<SandboxSnapshot> {
    return this.waitForRigSnapshot(ref);
  }

  /** @deprecated Use {@link Snapshots.previewScrub}. */
  getSandboxScrubPreview(sandboxRef: string): Promise<SandboxScrubPreview> {
    return this.getRigScrubPreview(sandboxRef);
  }

  /** @deprecated Use {@link Snapshots.handle}. */
  deleteSandboxSnapshot(ref: string): Promise<void> {
    return this.deleteRigSnapshot(ref);
  }

  /** @deprecated Use client.agentSessions.send through the grouped API. */
  async sendAgentSession(
    req: AgentSessionSendRequest,
  ): Promise<AgentSessionSendResponse> {
    return this.agentSessions.send(req);
  }

  /** @deprecated Use client.agentSessions.sendStream through the grouped API. */
  async sendAgentSessionStream(
    req: AgentSessionSendRequest,
    handlers: AgentSessionStreamHandlers = {},
  ): Promise<AgentSessionSendResponse> {
    return this.agentSessions.sendStream(req, handlers);
  }

  /** @deprecated Use client.agentSessions.list through the grouped API. */
  async listAgentSessions(limit?: number): Promise<ListAgentSessionsResponse> {
    return this.agentSessions.list({ limit });
  }

  /** @deprecated Use client.agentSessions.get through the grouped API. */
  async getAgentSession(sessionId: string): Promise<AgentSessionDetail> {
    return this.agentSessions.get(sessionId);
  }
}
