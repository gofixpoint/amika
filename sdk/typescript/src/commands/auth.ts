import { pushFlag } from "../args.js";
import type { RunOptions, RunResult, Runner } from "../runner.js";

export interface AuthExtractInput {
  /** Prefix each line with `export ` so output can be piped to `eval`. */
  exportShell?: boolean;
  homedir?: string;
  noOauth?: boolean;
}

export class AuthCommands {
  constructor(private readonly runner: Runner) {}

  status(options?: RunOptions): Promise<RunResult> {
    return this.runner.run(["auth", "status"], options);
  }

  buildExtractArgs(input: AuthExtractInput = {}): string[] {
    const args: string[] = ["auth", "extract"];
    pushFlag(args, "--export", input.exportShell);
    pushFlag(args, "--homedir", input.homedir);
    pushFlag(args, "--no-oauth", input.noOauth);
    return args;
  }

  extract(input: AuthExtractInput = {}, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildExtractArgs(input), options);
  }
}
