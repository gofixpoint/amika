import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "amika-action-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("runs the committed entry bundle against serialized HTTP", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      response.statusCode = 202;
      response.end(JSON.stringify(run("queued", null)));
      return;
    }
    if (request.url?.includes("/events")) {
      response.end(JSON.stringify({ items: [], next_sequence: 0 }));
      return;
    }
    response.end(JSON.stringify(run("completed", "success")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");

  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output.txt");
  await writeFile(eventPath, JSON.stringify({ repository: { id: 101 } }));
  await writeFile(outputPath, "");

  try {
    const result = await execFileAsync(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMIKA_TOKEN: "bundle-secret",
        INPUT_COMMAND: "true",
        "INPUT_REUSE-BRANCH-SANDBOX": "false",
        "INPUT_AMIKA-URL": `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: "amika/example",
        GITHUB_REPOSITORY_ID: "101",
        GITHUB_EVENT_NAME: "push",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "main",
        GITHUB_RUN_ID: "5001",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF:
          "amika/example/.github/workflows/ci.yml@refs/heads/main",
        GITHUB_JOB: "test",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    expect(result.stdout).toContain("::add-mask::bundle-secret");
    expect(result.stdout).toContain("completed successfully");
    expect(await readFile(outputPath, "utf8")).toContain("conclusion<<");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function run(status: "queued" | "completed", conclusion: "success" | null) {
  return {
    id: "scr_bundle",
    sandbox_id: "sbx_bundle",
    status,
    conclusion,
    exit_code: conclusion ? 0 : null,
  };
}
