import { Client, Sailbox } from "@sailresearch/sdk";
import type { SailboxConfig } from "../config";

export function createSailClient(config: SailboxConfig): Client {
  return Client.fromConfig(clientConfig(config));
}

export function getSailbox(
  config: SailboxConfig,
  providerSandboxId: string,
): Promise<Sailbox> {
  return Sailbox.get(providerSandboxId, { client: createSailClient(config) });
}

export function sailboxApiUrl(config: SailboxConfig): string {
  return config.sailboxApiUrl ?? "https://sailbox-api.sailresearch.com";
}

function clientConfig(config: SailboxConfig): {
  apiKey: string;
  apiUrl?: string;
  sailboxApiUrl?: string;
} {
  return {
    apiKey: config.apiKey,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    ...(config.sailboxApiUrl ? { sailboxApiUrl: config.sailboxApiUrl } : {}),
  };
}
