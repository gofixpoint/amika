/**
 * Runs the provider contract against `simulate`. This keeps the suite itself
 * honest on every `pnpm test` and makes `simulate` the reference provider.
 *
 * `simulate` has no shell. Below is what a POSIX shell prints for each
 * command the suite runs; it is loaded into the simulated world before the
 * suite starts. The scenarios in `./contract.ts` never see it: they run a
 * command and assert on its output, the same against simulate as against a
 * real vendor. A command missing here exits 0 with no output, so a scenario
 * that adds a command without adding it here fails.
 */
import { DEFAULT_HOME_DIR } from "../../constants";
import type { SandboxExecResult } from "../provider";
import {
  createSandboxProvider,
  getSandboxAdapter,
  type SandboxProviderDeps,
} from "../registry";
import {
  getSimulateWorld,
  type SimulateStreamChunk,
} from "../simulate/provider";
import { describeProviderContract } from "./contract";

const WORLD_ID = "provider-contract";

const ok = (stdout: string): SandboxExecResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

/** Command -> what `sh -c <command>` prints, with the options the suite uses. */
const SHELL: Array<[string, SandboxExecResult]> = [
  ["echo hello", ok("hello\n")],
  ["exit 3", { exitCode: 3, stdout: "", stderr: "" }],
  ["echo oops 1>&2", { exitCode: 0, stdout: "", stderr: "oops\n" }],
  ["pwd", ok("/tmp\n")], // run with cwd /tmp
  [`printf '%s\\n' "$CONTRACT_VAR"`, ok("from-contract\n")], // run with CONTRACT_VAR set
  [`printf '%s\\n' "$HOME"`, ok(`${DEFAULT_HOME_DIR}\n`)],
  ["echo back", ok("back\n")],
  ["echo via adapter", ok("via adapter\n")],
  [
    "echo out; echo err 1>&2",
    { exitCode: 0, stdout: "out\n", stderr: "err\n" },
  ],
];

/** Command -> how a real shell's output arrives over a stream. */
const STREAMS: Array<[string, SimulateStreamChunk[]]> = [
  [
    "echo first; sleep 2; echo second",
    [{ stdout: "first\n" }, { stdout: "second\n", delayMs: 2_000 }],
  ],
];

const world = getSimulateWorld(WORLD_ID);
for (const [command, result] of SHELL) world.onExec(command, result);
for (const [command, chunks] of STREAMS) world.onStream(command, chunks);

const DEPS: SandboxProviderDeps = {
  daytona: { apiKey: "", apiUrl: "" },
  e2b: null,
  freestyle: null,
  vercel: null,
  smol: null,
  amikaHostd: null,
  simulate: { worldId: WORLD_ID },
  resolveSnapshotId: async () => null,
};

describeProviderContract({
  createProvider: (resolveSnapshotId) =>
    createSandboxProvider("simulate", { ...DEPS, resolveSnapshotId }),
  openAdapter: (id) => getSandboxAdapter("simulate", DEPS, id),
  bootSnapshot: "base",
});
