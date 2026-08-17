import { CommandExitError, FileNotFoundError, type Sandbox } from "e2b";
import type {
  ExecOptions,
  ExecResult,
  SandboxAdapter,
} from "../../shared/adapter";

/** Adapter from E2B commands/files to Amika's provisioning seam. */
export class E2bAdapter implements SandboxAdapter {
  constructor(private readonly sandbox: Sandbox) {}

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    try {
      return await this.sandbox.commands.run(command, {
        cwd: opts?.cwd,
        envs: opts?.env,
        user: opts?.sudo ? "root" : undefined,
        timeoutMs: 0,
      });
    } catch (error) {
      if (error instanceof CommandExitError) return commandExitResult(error);
      throw error;
    }
  }

  async uploadFile(content: Buffer | string, path: string): Promise<void> {
    const data =
      typeof content === "string" ? content : Uint8Array.from(content).buffer;
    await this.sandbox.files.write(path, data);
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      return await this.sandbox.files.read(path);
    } catch (error) {
      if (error instanceof FileNotFoundError) return null;
      throw error;
    }
  }
}

function commandExitResult(error: CommandExitError): ExecResult {
  return {
    exitCode: error.exitCode,
    stdout: error.stdout,
    stderr: error.stderr,
  };
}
