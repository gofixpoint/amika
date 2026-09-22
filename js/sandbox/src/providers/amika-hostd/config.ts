/** Configuration for an Amika host daemon backed by local Smol machines. */
import type { SandboxConfigBase } from "../../config";

export interface AmikaHostdConfig extends SandboxConfigBase {
  /** Daemon origin. Defaults to http://127.0.0.1:3020. */
  apiUrl?: string;
  /** Outbound guest networking. Defaults to true; set false to disable. */
  network?: boolean;
  /** HTTP deadline. Defaults to 310000, allowing hostd's 300000 ms deadline. */
  requestTimeoutMs?: number;
}
