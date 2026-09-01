export { AmikaClient } from "@/client";
export type { AmikaClientOptions } from "@/client";

export { AmikaError, AmikaHTTPError, extractAgentAuthError } from "@/errors";

export { StaticTokenSource } from "@/token";
export type { TokenSource } from "@/token";

export {
  canonicalEd25519PublicKey,
  InvalidSSHSessionError,
  isValidSSHSession,
  SSH_SESSION_TRANSPORT_DIRECT_WS,
} from "@/ssh-session";
export type { SSHSession, SSHSessionTransport } from "@/ssh-session";

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
  CreateSandboxRequest,
  CreateSandboxSnapshotRequest,
  CreateSecretRequest,
  CreateSessionRequest,
  CreateSSHPublicKeyRequest,
  ExperimentalDaytonaSnapshot,
  MountedSecret,
  ProviderSecretListItem,
  ProviderSecretSummary,
  RemoteRepository,
  RemoteSandbox,
  RemoteSandboxCreator,
  RemoteSandboxService,
  ResolvedAgentCredential,
  RevokeSSHRequest,
  SandboxScrubPreview,
  SandboxServiceRequest,
  SandboxServiceResource,
  SandboxSnapshot,
  SSHInfo,
  SSHPublicKeySummary,
  Secret,
  Session,
  UpdateSecretRequest,
  UpdateSessionRequest,
} from "@/types";
