import { ApiClient, ConnectionConfig, Sandbox } from "e2b";
import type { E2bConfig } from "../config";

/** Options shared by E2B's static sandbox API calls. */
export function e2bApiOptions(config: E2bConfig): {
  apiKey: string;
  apiUrl?: string;
} {
  return {
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
  };
}

/** Read provisioned disk capacity omitted by E2B's public SDK mapper. */
export async function getE2bSandboxDiskSizeMib(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<number> {
  const client = new ApiClient(new ConnectionConfig(e2bApiOptions(config)));
  const response = await client.api.GET("/sandboxes/{sandboxID}", {
    params: { path: { sandboxID: providerSandboxId } },
  });
  if (response.error || !response.data) {
    throw new Error(
      `Unable to determine E2B disk capacity for ${providerSandboxId}`,
    );
  }
  return response.data.diskSizeMB;
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
