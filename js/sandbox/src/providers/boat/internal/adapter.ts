import type { SandboxAdapter } from "../../shared/adapter";
import { rigUserAdapter } from "../../shared/rig-user";
import type { BoatConfig } from "../config";
import { boatShell } from "./shell";

/** Open an adapter. No request is made until it is used. */
export function openBoatAdapter(
  config: BoatConfig,
  sandboxId: string,
): SandboxAdapter {
  return rigUserAdapter(boatShell(config, sandboxId));
}
