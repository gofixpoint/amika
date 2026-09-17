export { AmikaClient } from "@/client";
export type { AmikaClientOptions } from "@/client";

export { AmikaError, AmikaHTTPError, extractAgentAuthError } from "@/errors";

export {
  RESERVED_PORT_MAX,
  RESERVED_PORT_MIN,
  validateServicePort,
} from "@/types";

export { StaticTokenSource } from "@/token";
export type { TokenSource } from "@/token";

export type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSendRequest,
  AgentSessionSendResponse,
  AgentSessionStreamHandlers,
  AgentSessionSummary,
  AgentSessionUsage,
  ListAgentSessionsResponse,
} from "@/agent-sessions";

export type {
  AgentCredentialRef,
  AgentSendRequest,
  AgentSendResponse,
  CreateProviderSecretRequest,
  CreateRigRequest,
  CreateRigSnapshotRequest,
  CreateSecretRequest,
  CreateSessionRequest,
  ExperimentalDaytonaSnapshot,
  MountedSecret,
  ProviderSecretListItem,
  ProviderSecretSummary,
  RemoteRepository,
  RemoteRig,
  RemoteRigCreator,
  RemoteRigService,
  ResolvedAgentCredential,
  RigScrubPreview,
  RigServiceRequest,
  RigServiceResource,
  RigSnapshot,
  Secret,
  Session,
  UpdateSecretRequest,
  UpdateSessionRequest,
} from "@/types";

// Legacy sandbox spellings, kept so code written against earlier releases keeps
// compiling. Most are plain type aliases of the rig-named type above;
// `RemoteSandbox`, `SandboxSnapshot`, and `SandboxServiceResource` instead
// relax that type's rig-spelled fields to optional, and
// `CreateSandboxSnapshotRequest` keeps `sandboxRef` required. See the notes in
// `types.ts` — the distinction is what an assignability error will point at.
export type {
  CreateSandboxRequest,
  CreateSandboxSnapshotRequest,
  RemoteSandbox,
  RemoteSandboxCreator,
  RemoteSandboxService,
  SandboxScrubPreview,
  SandboxServiceRequest,
  SandboxServiceResource,
  SandboxSnapshot,
} from "@/types";
