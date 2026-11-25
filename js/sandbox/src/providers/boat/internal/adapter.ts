import {
  decodeUtf8,
  type ExecOptions,
  type ExecResult,
  type SandboxAdapter,
} from "../../shared/adapter";
import {
  RigFilePermissionError,
  rigUserOps,
  type RigUserOps,
} from "../../shared/rig-user";
import type { BoatConfig } from "../config";
import { boatShell } from "./shell";

/** The provisioning adapter: the rig user's commands and files on boat. */
export class BoatAdapter implements SandboxAdapter {
  private readonly ops: RigUserOps;

  constructor(config: BoatConfig, sandboxId: string) {
    this.ops = rigUserOps(boatShell(config, sandboxId));
  }

  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.ops.exec(command, opts);
  }

  uploadFile(content: Buffer | string, path: string): Promise<void> {
    return this.ops.writeFile(path, content);
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      const bytes = await this.ops.readFile(path);
      return bytes === null ? null : decodeUtf8(bytes);
    } catch (error) {
      if (error instanceof RigFilePermissionError) return null;
      throw error;
    }
  }
}

/** Open an adapter. No request is made until it is used. */
export function openBoatAdapter(
  config: BoatConfig,
  sandboxId: string,
): SandboxAdapter {
  return new BoatAdapter(config, sandboxId);
}
