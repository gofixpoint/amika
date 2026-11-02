/** Download and sweep saved ledgers without a persistent Actions runner. */
import { parseArgs } from "node:util";
import { githubActionsClient } from "../actions-client";
import { sweepActionsRun, actionsSweepInputSchema } from "../actions-ledgers";
import { sweepOptionsFromEnv } from "../sweep-options";
import { reportSweepResults } from "../sweep-report";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      "run-id": { type: "string" },
      directory: { type: "string" },
      "artifact-name": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values["run-id"] || !/^[1-9][0-9]*$/.test(values["run-id"])) {
    throw new Error("--run-id must be a positive GitHub Actions run id");
  }
  const input = actionsSweepInputSchema.parse({
    repository: values.repo,
    runId: Number(values["run-id"]),
    directory: values.directory,
    artifactName: values["artifact-name"],
  });
  const results = await sweepActionsRun(
    input,
    githubActionsClient,
    sweepOptionsFromEnv(process.env, values["dry-run"]),
  );
  reportSweepResults(results, input.directory, values["dry-run"]);
  console.log(`Updated ledgers: ${input.directory}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
