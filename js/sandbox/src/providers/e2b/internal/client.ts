import { Sandbox } from "e2b";
import type { E2bConfig } from "../config";

/** Options shared by E2B's static sandbox API calls. */
export function e2bApiOptions(config: E2bConfig): { apiKey: string } {
  return { apiKey: config.apiKey };
}

/** Connect to a sandbox, resuming it when it is paused. */
export function connectE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
  timeoutMs?: number,
): Promise<Sandbox> {
  return Sandbox.connect(providerSandboxId, {
    ...e2bApiOptions(config),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
