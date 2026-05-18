#!/usr/bin/env node
// Fake amika binary used by SDK tests.
//
// Behavior is controlled by env vars so we don't need to recompile per test:
//   FAKE_EXIT_CODE   - exit with this code (default: 0)
//   FAKE_STDOUT      - write this to stdout
//   FAKE_STDERR      - write this to stderr
//   FAKE_ECHO_ARGS   - if set, write JSON {args, stdin, cwd} to stdout
//   FAKE_SLEEP_MS    - wait this many ms before exiting
//   FAKE_READ_STDIN  - if set, read stdin and include it in the JSON echo

import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);

async function readStdin() {
  if (!process.env.FAKE_READ_STDIN && !process.env.FAKE_ECHO_ARGS) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const stdin = await readStdin();

if (process.env.FAKE_SLEEP_MS) {
  await delay(Number(process.env.FAKE_SLEEP_MS));
}

if (process.env.FAKE_ECHO_ARGS) {
  process.stdout.write(JSON.stringify({ args, stdin, cwd: process.cwd() }));
}

if (process.env.FAKE_STDOUT) process.stdout.write(process.env.FAKE_STDOUT);
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);

const code = process.env.FAKE_EXIT_CODE ? Number(process.env.FAKE_EXIT_CODE) : 0;
process.exit(code);
