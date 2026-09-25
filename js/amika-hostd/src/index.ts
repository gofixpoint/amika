#!/usr/bin/env node
/** `amika-hostd` command-line entry point. */
import { createInterface } from "node:readline/promises";
import { PromptCancelled, runCli } from "./internal/cli.js";
import { PROCESS_TITLE } from "./internal/daemon.js";

process.title = PROCESS_TITLE;

const EXIT_GRACE_MS = 1_000;

const shutdownSignal = () =>
  new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

/**
 * Resolve to `undefined` when the operator closes input (Ctrl-D), and reject
 * with `PromptCancelled` on Ctrl-C, which readline would otherwise treat as
 * closing input and so as skipping the question.
 */
async function prompt(question: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cancelled = new Promise<never>((_, reject) =>
    rl.once("SIGINT", () => {
      process.stdout.write("\n");
      reject(new PromptCancelled());
    }),
  );
  const closed = new Promise<undefined>((resolve) =>
    rl.once("close", () => resolve(undefined)),
  );
  try {
    return await Promise.race([rl.question(question), cancelled, closed]);
  } finally {
    rl.close();
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  self: [process.execPath, ...process.execArgv, process.argv[1]],
  shutdownSignal,
  prompt: process.stdin.isTTY && process.stdout.isTTY ? prompt : undefined,
});

// A request still waiting on the Smol runtime (up to its 5-minute timeout)
// would otherwise keep the process alive after the server has shut down.
// The delay lets pending output flush; an idle process exits before it.
setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
