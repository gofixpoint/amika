import {
  decodeUtf8,
  type ExecOptions,
  type ExecResult,
  type SandboxAdapter,
} from "../../shared/adapter";
import type { GcpConfig } from "../config";
import { gcpTarget, type GcpTarget } from "./client";
import {
  execGcpCommand,
  readGcpFileBytes,
  writeGcpFileWithParents,
} from "./exec";
import { isSftpPermissionDenied } from "./ssh";

/** The provisioning adapter over SSH to a Compute Engine VM. */
export class GcpAdapter implements SandboxAdapter {
  constructor(
    private readonly target: GcpTarget,
    private readonly instanceName: string,
  ) {}

  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return execGcpCommand(this.target, this.instanceName, command, opts);
  }

  uploadFile(content: Buffer | string, path: string): Promise<void> {
    return writeGcpFileWithParents(
      this.target,
      this.instanceName,
      path,
      content,
    );
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      const bytes = await readGcpFileBytes(
        this.target,
        this.instanceName,
        path,
      );
      return bytes === null ? null : decodeUtf8(bytes);
    } catch (error) {
      if (isSftpPermissionDenied(error)) return null;
      throw error;
    }
  }
}

/** Open an adapter. No request is made until it is used. */
export function openGcpAdapter(
  config: GcpConfig,
  instanceName: string,
): SandboxAdapter {
  return new GcpAdapter(gcpTarget(config), instanceName);
}
