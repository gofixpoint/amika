import type { SandboxAdapter } from "../../shared/adapter";
import { rigUserAdapter } from "../../shared/rig-user";
import type { RuntimeConfig } from "../config";
import { runtimeShell } from "./shell";

/** Open an adapter. No request is made until it is used. */
export function openRuntimeAdapter(
  config: RuntimeConfig,
  sandboxId: string,
): SandboxAdapter {
  return rigUserAdapter(runtimeShell(config, sandboxId));
}
