import { type Rigs } from "./rigs/rig.js";
import { type AgentSessions } from "./agent-sessions/types.js";
import { type Snapshots } from "./snapshots/snapshot.js";
import { type Services } from "./services/types.js";
import { type Secrets } from "./secrets/types.js";
import { type AgentCredentials } from "./agent-credentials/types.js";
import { type Repositories } from "./repositories/types.js";

import { LegacyClient } from "./legacy/client.js";
import { HTTPClient } from "./internal/http.js";
import { resolveTokenSource } from "./internal/auth.js";
import type { AmikaClientOptions } from "./options.js";
export type { AmikaClientOptions } from "./options.js";
import { createRigs } from "./rigs/client.js";
import { createAgentSessions } from "./agent-sessions/client.js";
import { createSnapshots } from "./snapshots/client.js";
import { createServices } from "./services/client.js";
import { createSecrets } from "./secrets/client.js";
import { createAgentCredentials } from "./agent-credentials/client.js";
import { createRepositories } from "./repositories/client.js";

/**
 * Create cloud development rigs and run coding agents with explicit credentials.
 * Methods on each collection return ordinary promises; handle() makes no request.
 * @example
 * const client = new AmikaClient({ apiKey: process.env.AMIKA_API_KEY! });
 * const rig = await client.rigs.create({ repoUrl: "https://github.com/org/repo", agentCredentials: [{ kind: "claude" }] });
 * await rig.wait();
 */
export class AmikaClient extends LegacyClient {
  /** Create and inspect rigs; construct unchecked handles and wait for readiness. */
  readonly rigs: Rigs;
  /** Send prompts and inspect durable agent chats. */
  readonly agentSessions: AgentSessions;
  /** Capture, inspect, and wait for rig snapshots. */
  readonly snapshots: Snapshots;
  /** Manage published ports across rigs. Rig.services remains fetched service data. */
  readonly services: Services;
  /** Manage named secret values and list their metadata. */
  readonly secrets: Secrets;
  /** Manage stored credentials for agent providers such as Claude and Codex. */
  readonly agentCredentials: AgentCredentials;
  /** List repositories known to your organization. */
  readonly repositories: Repositories;

  constructor(options: AmikaClientOptions) {
    super();
    const http = new HTTPClient({
      baseUrl: options.baseUrl ?? "https://app.amika.dev",
      tokenSource: resolveTokenSource(options),
      fetch: options.fetch,
    });
    this.agentSessions = createAgentSessions(http);
    this.rigs = createRigs(http, this.agentSessions);
    this.snapshots = createSnapshots(http);
    this.services = createServices(http);
    this.secrets = createSecrets(http);
    this.agentCredentials = createAgentCredentials(http);
    this.repositories = createRepositories(http);
  }
}
