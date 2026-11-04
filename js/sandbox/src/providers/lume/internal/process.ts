/** Run a local program and collect its output. */
import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcessOptions {
  /** Bytes for the program's stdin. Without it, stdin is `/dev/null`. */
  input?: Buffer | string;
  /** The program's whole environment. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** Kill the program after this long. Default: no limit. */
  timeoutMs?: number;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  opts?: ProcessOptions,
) => Promise<ProcessResult>;

/** Spawn `command` with `args` (no shell) and wait for it to exit. */
export const runProcess: ProcessRunner = (command, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: opts.timeoutMs,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`${command} was killed by ${signal}`));
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (opts.input !== undefined) {
      // A program that exits without reading all of stdin closes the pipe;
      // that is its choice, not a failure of the run.
      child.stdin!.once("error", () => {});
      child.stdin!.end(opts.input);
    }
  });
