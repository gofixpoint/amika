import { envRecordToFlags, pushFlag, pushRepeated, scopeFlag } from "../args.js";
import type { RunOptions, RunResult, Runner } from "../runner.js";

export type SandboxScope = "local" | "remote";

export interface SandboxCreateInput {
  name?: string;
  provider?: string;
  image?: string;
  preset?: string;
  mount?: string[];
  volume?: string[];
  /** Pass `true` to mount the repo root, or a string path to mount the repo containing that path. */
  git?: boolean | string;
  noClean?: boolean;
  env?: Record<string, string>;
  port?: string[];
  portHostIp?: string;
  yes?: boolean;
  connect?: boolean;
  setupScript?: string;
  branch?: string;
  newBranch?: string;
  secret?: string[];
  scope?: SandboxScope;
}

export interface SandboxDeleteInput {
  names: string[];
  deleteVolumes?: boolean;
  keepVolumes?: boolean;
  scope?: SandboxScope;
}

export interface SandboxStartStopInput {
  names: string[];
  scope?: SandboxScope;
}

export interface SandboxListInput {
  scope?: SandboxScope;
}

export interface SandboxAgentSendInput {
  name: string;
  /** Prompt for the agent. If omitted, you should provide `stdin` in options. */
  message?: string;
  noWait?: boolean;
  workdir?: string;
  agent?: string;
  scope?: SandboxScope;
}

export class SandboxCommands {
  constructor(private readonly runner: Runner) {}

  buildCreateArgs(input: SandboxCreateInput = {}): string[] {
    const args: string[] = ["sandbox", "create"];
    scopeFlag(args, input.scope);
    pushFlag(args, "--name", input.name);
    pushFlag(args, "--provider", input.provider);
    pushFlag(args, "--image", input.image);
    pushFlag(args, "--preset", input.preset);
    pushRepeated(args, "--mount", input.mount);
    pushRepeated(args, "--volume", input.volume);
    if (typeof input.git === "string") {
      args.push("--git", input.git);
    } else if (input.git === true) {
      args.push("--git");
    }
    pushFlag(args, "--no-clean", input.noClean);
    envRecordToFlags(args, "--env", input.env);
    pushRepeated(args, "--port", input.port);
    pushFlag(args, "--port-host-ip", input.portHostIp);
    pushFlag(args, "--yes", input.yes);
    pushFlag(args, "--connect", input.connect);
    pushFlag(args, "--setup-script", input.setupScript);
    pushFlag(args, "--branch", input.branch);
    pushFlag(args, "--new-branch", input.newBranch);
    pushRepeated(args, "--secret", input.secret);
    return args;
  }

  create(input: SandboxCreateInput = {}, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildCreateArgs(input), options);
  }

  buildListArgs(input: SandboxListInput = {}): string[] {
    const args: string[] = ["sandbox", "list"];
    scopeFlag(args, input.scope);
    return args;
  }

  list(input: SandboxListInput = {}, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildListArgs(input), options);
  }

  buildDeleteArgs(input: SandboxDeleteInput): string[] {
    const args: string[] = ["sandbox", "delete"];
    scopeFlag(args, input.scope);
    pushFlag(args, "--delete-volumes", input.deleteVolumes);
    pushFlag(args, "--keep-volumes", input.keepVolumes);
    args.push(...input.names);
    return args;
  }

  delete(input: SandboxDeleteInput, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildDeleteArgs(input), options);
  }

  buildStartArgs(input: SandboxStartStopInput): string[] {
    const args: string[] = ["sandbox", "start"];
    scopeFlag(args, input.scope);
    args.push(...input.names);
    return args;
  }

  start(input: SandboxStartStopInput, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildStartArgs(input), options);
  }

  buildStopArgs(input: SandboxStartStopInput): string[] {
    const args: string[] = ["sandbox", "stop"];
    scopeFlag(args, input.scope);
    args.push(...input.names);
    return args;
  }

  stop(input: SandboxStartStopInput, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildStopArgs(input), options);
  }

  buildAgentSendArgs(input: SandboxAgentSendInput): string[] {
    const args: string[] = ["sandbox", "agent-send"];
    scopeFlag(args, input.scope);
    pushFlag(args, "--no-wait", input.noWait);
    pushFlag(args, "--workdir", input.workdir);
    pushFlag(args, "--agent", input.agent);
    args.push(input.name);
    if (input.message !== undefined) args.push(input.message);
    return args;
  }

  agentSend(input: SandboxAgentSendInput, options?: RunOptions): Promise<RunResult> {
    return this.runner.run(this.buildAgentSendArgs(input), options);
  }
}
