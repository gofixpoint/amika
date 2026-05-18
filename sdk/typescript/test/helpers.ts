import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const fakeBinaryPath = path.join(here, "fixtures", "fake-amika.mjs");

export interface FakeEnv {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  echoArgs?: boolean;
  sleepMs?: number;
  readStdin?: boolean;
}

export function fakeEnv(opts: FakeEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.exitCode !== undefined) env.FAKE_EXIT_CODE = String(opts.exitCode);
  if (opts.stdout !== undefined) env.FAKE_STDOUT = opts.stdout;
  if (opts.stderr !== undefined) env.FAKE_STDERR = opts.stderr;
  if (opts.echoArgs) env.FAKE_ECHO_ARGS = "1";
  if (opts.sleepMs !== undefined) env.FAKE_SLEEP_MS = String(opts.sleepMs);
  if (opts.readStdin) env.FAKE_READ_STDIN = "1";
  return env;
}
