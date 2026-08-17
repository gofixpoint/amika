/**
 * Daytona adapter for the provider-agnostic {@link SandboxAdapter} port.
 *
 * A thin passthrough: it wraps an already-fetched Daytona `Sandbox` and maps
 * the adapter primitives onto the SDK calls the Daytona provider has always
 * made (`process.executeCommand`, `fs.uploadFile`, `fs.downloadFile`). The
 * shared provisioning orchestration runs against this with no behavior change
 * versus the previous direct calls.
 */
import type { Daytona } from "@daytonaio/sdk";
import { executeCommand } from "./commands";
import type {
  ExecOptions,
  ExecResult,
  SandboxAdapter,
} from "../../shared/adapter";

type DaytonaSandbox = Awaited<ReturnType<Daytona["get"]>>;

export class DaytonaAdapter implements SandboxAdapter {
  /**
   * @param sandbox the already-fetched Daytona sandbox handle.
   * @param client the SDK client the sandbox was fetched with, retained so
   *   callers can reuse the one already-constructed client for further SDK work
   *   instead of building a fresh one. Optional — provider-specific and off the
   *   SDK-free {@link SandboxAdapter} port (Vercel's static SDK has no client).
   */
  constructor(
    private readonly sandbox: DaytonaSandbox,
    readonly client?: Daytona,
  ) {}

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    // Delegates to the provider's public exec path so both share one command
    // builder (sudo → root shell + `--preserve-env`) and one runner. That
    // runner calls the SDK's `process.executeCommand`, whose single combined
    // string it splits back into two streams on-box; see `commands.ts` for why
    // a process session is the wrong transport for an ordinary command.
    return executeCommand(this.sandbox, command, opts);
  }

  async uploadFile(content: Buffer | string, path: string): Promise<void> {
    const buffer =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    await this.sandbox.fs.uploadFile(buffer, path);
  }

  async downloadFile(path: string): Promise<string | null> {
    try {
      const content = await this.sandbox.fs.downloadFile(path);
      return content.toString("utf8");
    } catch {
      return null;
    }
  }
}
