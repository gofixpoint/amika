/** Local smol machines provider, backed by a separately managed smolvm serve. */
import type { SmolConfig } from "./config";
import { smolCapabilities } from "./capabilities";
import { defineProvider } from "../shared/define-provider";
import { openSmolRuntimeAdapter, smolDefinition } from "./runtime";

export default defineProvider(smolCapabilities, (config: SmolConfig) =>
  smolDefinition(config, "smol"),
);

export async function openSmolAdapter(config: SmolConfig, id: string) {
  return openSmolRuntimeAdapter(config, id, "smol");
}
