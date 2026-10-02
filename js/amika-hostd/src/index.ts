#!/usr/bin/env node
/** `amika-hostd` command-line entry point. */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
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
async function prompt(
  question: string,
  { hidden = false }: { hidden?: boolean } = {},
): Promise<string | undefined> {
  // A hidden answer is typed into an output that drops everything after the
  // question, so the terminal never echoes it.
  let muted = false;
  const output = hidden
    ? new Writable({
        write(chunk, encoding, done) {
          if (!muted) process.stdout.write(chunk, encoding);
          done();
        },
      })
    : process.stdout;
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
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
    const answer = rl.question(question);
    muted = hidden;
    return await Promise.race([answer, cancelled, closed]);
  } finally {
    rl.close();
    if (hidden) process.stdout.write("\n");
  }
}

// `up` spawns the background daemon with an IPC channel and sends its output
// to the log file, so timestamp each line there, including every line of a
// multiline message. Checked before the daemon disconnects from `up`.
const stamp: (text: string) => string = process.channel
  ? (text) => {
      const now = new Date().toISOString();
      // Blank lines, such as the one `USAGE` ends with, stay unstamped.
      return text.replace(/^(?!$)/gm, `${now} `);
    }
  : (text) => text;

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(stamp(line)),
  err: (line) => console.error(stamp(line)),
  self: [process.execPath, ...process.execArgv, process.argv[1]],
  shutdownSignal,
  ...(process.stdin.isTTY && process.stdout.isTTY
    ? {
        prompt: (question: string) => prompt(question),
        promptSecret: (question: string) => prompt(question, { hidden: true }),
      }
    : {}),
});

// A request still waiting on the Smol runtime (up to its 5-minute timeout)
// would otherwise keep the process alive after the server has shut down.
// The delay lets pending output flush; an idle process exits before it.
setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
