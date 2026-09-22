/** Sandbox resources backed by an Amika host daemon's machine API. */
import type { AmikaHostdConfig } from "./config";
import { amikaHostdCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { openSmolRuntimeAdapter, smolDefinition } from "../smol/runtime";

interface AmikaHostdDeps {
  config: AmikaHostdConfig;
  fetcher?: typeof fetch;
}

export default defineProvider(
  amikaHostdCapabilities,
  ({ config, fetcher }: AmikaHostdDeps) =>
    smolDefinition(runtimeConfig(config), "amika-hostd", fetcher),
);

export async function openAmikaHostdAdapter(
  config: AmikaHostdConfig,
  id: string,
  fetcher = fetch,
) {
  return openSmolRuntimeAdapter(
    runtimeConfig(config),
    id,
    "amika-hostd",
    fetcher,
  );
}

function runtimeConfig(config: AmikaHostdConfig): AmikaHostdConfig {
  return {
    ...config,
    apiUrl: config.apiUrl ?? "http://127.0.0.1:3020",
    requestTimeoutMs: config.requestTimeoutMs ?? 310_000,
  };
}
