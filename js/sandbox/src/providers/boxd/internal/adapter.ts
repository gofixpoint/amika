import type { SandboxAdapter } from "../../shared/adapter";
import { rigUserAdapter } from "../../shared/rig-user";
import type { BoxdConfig } from "../config";
import { boxdShell } from "./shell";

/** Open an adapter. No request is made until it is used. */
export function openBoxdAdapter(
  config: BoxdConfig,
  machineId: string,
): SandboxAdapter {
  return rigUserAdapter(boxdShell(config, machineId));
}
