import { pushFlag } from "../args.js";
import type { RunOptions, RunResult, Runner } from "../runner.js";

export interface VolumeDeleteInput {
  names: string[];
  force?: boolean;
}

export class VolumeCommands {
  constructor(private readonly runner: Runner) {}

  buildListArgs(): string[] {
    return ["volume", "list"];
  }

  list(options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildListArgs(), options);
  }

  buildDeleteArgs(input: VolumeDeleteInput): string[] {
    const args: string[] = ["volume", "delete"];
    pushFlag(args, "--force", input.force);
    args.push(...input.names);
    return args;
  }

  delete(input: VolumeDeleteInput, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildDeleteArgs(input), options);
  }
}
