#!/usr/bin/env node
/** `amika-hostd` command-line entry point. */
import { runCli } from "./internal/cli.js";
import { PROCESS_TITLE } from "./internal/daemon.js";

process.title = PROCESS_TITLE;

const EXIT_GRACE_MS = 1_000;

const shutdownSignal = () =>
  new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  self: [process.execPath, ...process.execArgv, process.argv[1]],
  shutdownSignal,
});

// A request still waiting on the Smol runtime (up to its 5-minute timeout)
// would otherwise keep the process alive after the server has shut down.
// The delay lets pending output flush; an idle process exits before it.
setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
