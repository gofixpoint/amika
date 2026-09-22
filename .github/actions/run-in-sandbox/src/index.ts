import { appendFileSync, readFileSync } from "node:fs";

import { runAction, type ActionPorts, type GithubEvent } from "./action.js";

async function main(): Promise<void> {
  const ports = createPorts();
  try {
    await runAction(process.env, readGithubEvent(process.env), ports);
  } catch (error) {
    process.stderr.write(
      `::error::${escapeWorkflowCommand(errorMessage(error))}\n`,
    );
    process.exitCode = 1;
  }
}

function createPorts(): ActionPorts {
  return {
    fetch,
    now: Date.now,
    sleep,
    stdout: (content) => process.stdout.write(content),
    stderr: (content) => process.stderr.write(content),
    maskSecret: (secret) => {
      process.stdout.write(`::add-mask::${escapeWorkflowCommand(secret)}\n`);
    },
    setOutput: writeOutput,
    notice: (message) => {
      process.stdout.write(`::notice::${escapeWorkflowCommand(message)}\n`);
    },
    warning: (message) => {
      process.stderr.write(`::warning::${escapeWorkflowCommand(message)}\n`);
    },
    onSignal: (handler) => {
      const onSigint = () => handler("SIGINT");
      const onSigterm = () => handler("SIGTERM");
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
    },
  };
}

function readGithubEvent(env: NodeJS.ProcessEnv): GithubEvent {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) throw new Error("GITHUB_EVENT_PATH is required");
  return JSON.parse(readFileSync(path, "utf8")) as GithubEvent;
}

function writeOutput(name: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) throw new Error("GITHUB_OUTPUT is required");
  const delimiter = `amika_${crypto.randomUUID()}`;
  appendFileSync(
    path,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    "utf8",
  );
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    function finish(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function escapeWorkflowCommand(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
