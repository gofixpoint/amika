/** Restore and sweep ledgers from a finished, trusted GitHub Actions run. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseLedger } from "./ledger";
import { AUDIT_FILE_NAME } from "./run-dir";
import { sweepRun, type SweepOptions, type SweepRunResult } from "./sweep";

export const ACTIONS_LEDGER_ARTIFACT = "sandbox-contract-ledgers";

export const actionsSweepInputSchema = z.object({
  repository: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/)
    .refine((s) => ![".", ".."].includes(s.split("/")[1])),
  runId: z.number().int().positive().safe(),
  directory: z.string().min(1),
  artifactName: z.string().min(1).optional(),
});
export type ActionsSweepInput = z.infer<typeof actionsSweepInputSchema>;

export interface ActionsClient {
  json(endpoint: string): Promise<unknown>;
  download(
    repository: string,
    runId: number,
    artifact: string,
    directory: string,
  ): Promise<void>;
}

const repositorySchema = z.object({ default_branch: z.string().min(1) });
const runSchema = z.object({
  id: z.number().int().positive(),
  status: z.string(),
  event: z.string(),
  run_attempt: z.number().int().positive(),
  head_branch: z.string(),
  head_sha: z.string().min(1),
  head_repository: z.object({ full_name: z.string() }),
});

const resourceFields = {
  kind: z.enum(["sandbox", "snapshot", "ssh-access"]),
  id: z.string().min(1),
  at: z.string().min(1),
};
const ledgerEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("run"),
    provider: z.string().min(1),
    target: z.record(z.string(), z.string()),
    at: z.string().min(1),
  }),
  z.object({
    event: z.literal("created"),
    ...resourceFields,
    provider: z.string().min(1),
    name: z.string().min(1),
    test: z.string(),
  }),
  z.object({
    event: z.literal("identified"),
    ...resourceFields,
    providerId: z.string().min(1),
  }),
  z.object({
    event: z.literal("deleted"),
    ...resourceFields,
    verified: z.union([z.literal(true), z.literal("unsupported")]),
    swept: z.literal(true).optional(),
  }),
  z.object({
    event: z.literal("delete_failed"),
    ...resourceFields,
    error: z.string(),
    swept: z.literal(true).optional(),
  }),
]);

/**
 * Only a completed run on this repository's default branch may supply
 * cleanup targets. Fork/PR artifacts must never drive privileged deletes.
 * A second status check detects a rerun started during the download.
 */
export async function sweepActionsRun(
  input: ActionsSweepInput,
  client: ActionsClient,
  options: Omit<SweepOptions, "isRunAlive">,
): Promise<SweepRunResult[]> {
  const parsed = actionsSweepInputSchema.parse(input);
  const repo = parsed.repository.split("/").map(encodeURIComponent).join("/");
  const endpoint = `repos/${repo}/actions/runs/${parsed.runId}`;
  const repository = repositorySchema.parse(await client.json(`repos/${repo}`));
  const run = runSchema.parse(await client.json(endpoint));
  validateSource(run, parsed, repository.default_branch);
  const directory = path.resolve(parsed.directory);
  if (
    existsSync(directory) &&
    (lstatSync(directory).isSymbolicLink() || readdirSync(directory).length > 0)
  ) {
    throw new Error(
      "the download directory must be new or empty; refusing to overwrite existing ledgers",
    );
  }
  mkdirSync(directory, { recursive: true });
  const artifact =
    parsed.artifactName ?? `${ACTIONS_LEDGER_ARTIFACT}-${run.run_attempt}`;
  await client.download(parsed.repository, parsed.runId, artifact, directory);
  const after = runSchema.parse(await client.json(endpoint));
  validateSource(after, parsed, repository.default_branch);
  if (
    after.run_attempt !== run.run_attempt ||
    after.head_sha !== run.head_sha
  ) {
    throw new Error(
      "the source run changed during download; no resources were swept",
    );
  }
  const files = findLedgers(directory);
  if (files.length === 0) {
    throw new Error(
      `artifact ${artifact} contains no ${AUDIT_FILE_NAME} files; no resources were swept`,
    );
  }
  // Validate the entire download before any provider receives a delete.
  for (const file of files) {
    const events = parseLedger(readFileSync(file, "utf8"));
    if (
      !z.array(ledgerEventSchema).safeParse(events).success ||
      events.filter((e) => e.event === "run").length !== 1
    ) {
      throw new Error(
        `invalid or incomplete ledger ${file}; no resources were swept`,
      );
    }
  }
  // The source run is confirmed finished. Its PID belongs to another machine
  // and must not be checked against unrelated processes on this runner.
  const sweepOptions = { ...options, isRunAlive: () => false };
  const results: SweepRunResult[] = [];
  for (const file of files) {
    results.push(
      await sweepRun(path.basename(path.dirname(file)), file, sweepOptions),
    );
  }
  return results;
}

function validateSource(
  run: z.infer<typeof runSchema>,
  input: ActionsSweepInput,
  defaultBranch: string,
): void {
  if (
    run.id !== input.runId ||
    run.head_repository.full_name.toLowerCase() !==
      input.repository.toLowerCase()
  ) {
    throw new Error(
      "the source run does not belong to the requested repository",
    );
  }
  if (run.status !== "completed")
    throw new Error("the source Actions run is still active; refusing cleanup");
  if (
    run.head_branch !== defaultBranch ||
    !["push", "schedule", "workflow_dispatch"].includes(run.event)
  ) {
    throw new Error(
      "only push, scheduled, or manually dispatched runs on the default branch are trusted; refusing cleanup",
    );
  }
}

function findLedgers(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("ledger artifacts must not contain symbolic links");
    if (entry.isDirectory()) files.push(...findLedgers(file));
    else if (entry.name === AUDIT_FILE_NAME) files.push(file);
  }
  return files.sort();
}
