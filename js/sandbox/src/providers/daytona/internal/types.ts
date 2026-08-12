/**
 * Daytona-internal type aliases.
 *
 * The provider-agnostic shapes live in `../provider` (the abstraction owns
 * them). This module re-exports them under Daytona names for the Daytona
 * implementation files and the package's public index, and defines the
 * constants that are genuinely Daytona-specific.
 */
export {
  RepositoryCloneError,
  type McpIntegrationInput,
  type SandboxService,
  type CreateSandboxProviderInput as DaytonaCreateRequest,
  type InitializeSandboxInput as DaytonaInitializeRequest,
  type SandboxInitializeResult as DaytonaInitializeResult,
} from "../../provider";

export const DAYTONA_PROVIDER = "daytona";

export const SIGNED_URL_EXPIRY_S = 24 * 60 * 60; // 24 hours (max allowed)
