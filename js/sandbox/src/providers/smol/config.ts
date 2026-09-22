/** Configuration for the local smolvm HTTP runtime. */
import type { SandboxConfigBase } from "../../config";

export interface SmolConfig extends SandboxConfigBase {
  /** smolvm serve origin. Defaults to http://127.0.0.1:8080. */
  apiUrl?: string;
  /** Outbound guest networking. Defaults to false. */
  network?: boolean;
  /** HTTP deadline, including image pulls and command execution. Default: 300000. */
  requestTimeoutMs?: number;
}
