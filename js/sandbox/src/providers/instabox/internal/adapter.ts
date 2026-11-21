import {
  decodeUtf8,
  type ExecOptions,
  type ExecResult,
  type SandboxAdapter,
} from "../../shared/adapter";
import type { InstaboxConfig } from "../config";
import { execInstabox } from "./exec";
import {
  isPermissionDenied,
  readInstaboxFile,
  writeInstaboxFile,
} from "./operations";

/** The provisioning adapter over the Instabox REST API. */
export class InstaboxAdapter implements SandboxAdapter {
  constructor(
    private readonly config: InstaboxConfig,
    private readonly machineId: string,
  ) {}

  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return execInstabox(this.config, this.machineId, command, opts);
  }

  uploadFile(content: Buffer | string, path: string): Promise<void> {
    return writeInstaboxFile(this.config, this.machineId, path, content);
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      const bytes = await readInstaboxFile(this.config, this.machineId, path);
      return bytes === null ? null : decodeUtf8(bytes);
    } catch (error) {
      if (isPermissionDenied(error)) return null;
      throw error;
    }
  }
}

/** Open an adapter. No request is made until it is used. */
export function openInstaboxAdapter(
  config: InstaboxConfig,
  machineId: string,
): SandboxAdapter {
  return new InstaboxAdapter(config, machineId);
}
