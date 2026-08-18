import type { SandboxConfigBase } from "../../config";

/** Credentials for the hosted E2B API. */
export interface E2bConfig extends SandboxConfigBase {
  apiKey: string;
}
