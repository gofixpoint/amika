import type { SandboxConfigBase } from "../../config";

/** Credentials for the hosted E2B API. */
export interface E2bConfig extends SandboxConfigBase {
  apiKey: string;
}

/** Home directory baked into every Amika E2B template. */
export const E2B_HOME_DIR = "/home/amika";
