import type { SandboxAdapter } from "../../shared/adapter";
import { rigUserAdapter } from "../../shared/rig-user";
import type { OrbleConfig } from "../config";
import { orbleShell } from "./shell";

/** Open an adapter. No request is made until it is used. */
export function openOrbleAdapter(
  config: OrbleConfig,
  boxName: string,
): SandboxAdapter {
  return rigUserAdapter(orbleShell(config, boxName));
}
