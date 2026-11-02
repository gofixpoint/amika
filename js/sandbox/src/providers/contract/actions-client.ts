/** GitHub CLI transport. Authentication comes from gh login or GH_TOKEN. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActionsClient } from "./actions-ledgers";

const execFileAsync = promisify(execFile);

export const githubActionsClient: ActionsClient = {
  async json(endpoint) {
    const { stdout } = await execFileAsync("gh", ["api", endpoint], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  },
  async download(repository, runId, artifact, directory) {
    await execFileAsync("gh", [
      "run",
      "download",
      String(runId),
      "--repo",
      repository,
      "--name",
      artifact,
      "--dir",
      directory,
    ]);
  },
};
