/**
 * Provider-facing shared types owned by the provider layer.
 */

export type SandboxProviderName =
  | "daytona"
  | "freestyle"
  | "sailbox"
  | "vercel";

export type ServiceProtocol = "tcp" | "udp";
export type ServiceUrlScheme = "http" | "https";

/** A live service exposed by a sandbox (name, signed URL, ports, protocol). */
export interface SandboxService {
  name: string;
  url: string;
  hostPort: number;
  containerPort: number;
  protocol: ServiceProtocol;
  /**
   * Authored URL scheme from the repo-config service definition, carried
   * through so `seedSystemSandboxServices` records the intended scheme rather
   * than inferring one from the (initially empty) live URL. Absent for services
   * with no authored scheme (e.g. the built-in coding-agent entry).
   */
  urlScheme?: "http" | "https";
}

/**
 * Service port/protocol shapes the provider API references. These mirror the
 * caller's repo-config service-definition types (structurally identical), so
 * resolved service definitions flow into the provider `create`/`refreshUrls`
 * calls without conversion; the package keeps its own copy so it carries no
 * dependency on the caller's repo-config domain.
 */
export interface ServicePortDefinition {
  port: number;
  protocol: ServiceProtocol;
  url_scheme: ServiceUrlScheme | null;
}

export interface ServiceDefinitionData {
  name: string;
  ports: ServicePortDefinition[];
}
