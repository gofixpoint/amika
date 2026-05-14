import { AuthCommands } from "./commands/auth.js";
import { SandboxCommands } from "./commands/sandbox.js";
import { VolumeCommands } from "./commands/volume.js";
import { Runner, type RunOptions, type RunResult, type RunnerOptions } from "./runner.js";

export interface AmikaClientOptions extends RunnerOptions {}

export class AmikaClient {
  readonly runner: Runner;
  readonly sandbox: SandboxCommands;
  readonly volume: VolumeCommands;
  readonly auth: AuthCommands;

  constructor(options: AmikaClientOptions = {}) {
    this.runner = new Runner(options);
    this.sandbox = new SandboxCommands(this.runner);
    this.volume = new VolumeCommands(this.runner);
    this.auth = new AuthCommands(this.runner);
  }

  raw(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.runner.run(args, options);
  }

  async version(options?: RunOptions): Promise<string> {
    const result = await this.runner.run(["--version"], options);
    return result.stdout.trim();
  }
}
