import { spawn } from "node:child_process";

import { AmikaBinaryNotFoundError, AmikaCommandError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunnerOptions {
  binary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}

export class Runner {
  readonly binary: string;
  readonly defaultCwd: string | undefined;
  readonly defaultEnv: NodeJS.ProcessEnv | undefined;
  readonly defaultTimeoutMs: number | undefined;

  constructor(options: RunnerOptions = {}) {
    this.binary = options.binary ?? "amika";
    this.defaultCwd = options.cwd;
    this.defaultEnv = options.env;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const cwd = options.cwd ?? this.defaultCwd;
    const env = options.env ?? this.defaultEnv;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<RunResult>((resolve, reject) => {
      let child;
      try {
        child = spawn(this.binary, [...args], {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(wrapSpawnError(this.binary, err));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
      };

      const finishError = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
      };

      const timeoutHandle = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs)
        : undefined;

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      child.on("error", (err: NodeJS.ErrnoException) => {
        finishError(wrapSpawnError(this.binary, err));
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");

        if (timedOut) {
          reject(
            new AmikaCommandError(
              `amika ${args.join(" ")} timed out after ${timeoutMs}ms`,
              { args, exitCode: code, signal, stdout, stderr },
            ),
          );
          return;
        }

        if (aborted) {
          reject(
            new AmikaCommandError(`amika ${args.join(" ")} aborted`, {
              args,
              exitCode: code,
              signal,
              stdout,
              stderr,
            }),
          );
          return;
        }

        const exitCode = code ?? -1;
        if (exitCode !== 0) {
          reject(
            new AmikaCommandError(
              `amika ${args.join(" ")} exited with code ${exitCode}`,
              { args, exitCode: code, signal, stdout, stderr },
            ),
          );
          return;
        }

        resolve({ args, exitCode, stdout, stderr });
      });

      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }
    });
  }
}

function wrapSpawnError(binary: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "EACCES") {
    return new AmikaBinaryNotFoundError(binary, err);
  }
  return err instanceof Error ? err : new Error(String(err));
}
