// src/index.ts
import { appendFileSync, readFileSync } from "node:fs";

// src/action.ts
import { createHash } from "node:crypto";
var DEFAULT_AMIKA_URL = "https://app.amika.dev";
var COMMAND_RUN_API_PATH = "/api/v0beta1/sandbox-command-runs";
var GITHUB_ACTION_COMMAND_RUN_API_PATH = "/api/v0beta1/github-actions/sandbox-command-runs";
var MAX_HTTP_ATTEMPTS = 4;
var POLL_INTERVAL_MS = 1e3;
var COMPLETION_GRACE_MS = 5 * 60 * 1e3;
async function runAction(env, event, ports) {
  const token = requireEnvironment(env, "AMIKA_TOKEN");
  ports.maskSecret(token);
  const context = parseActionContext(env, event, token);
  const abort = new AbortController();
  let run = null;
  let completed = false;
  const cancel = async () => {
    if (!run || completed) return;
    await cancelRun(context, run.id, ports).catch((error) => {
      ports.warning(
        `Could not request Amika cancellation: ${errorMessage(error)}`
      );
    });
  };
  const removeSignalListeners = ports.onSignal((signal) => {
    ports.warning(`Received ${signal}; requesting cancellation from Amika.`);
    void cancel();
    abort.abort(new Error(`GitHub Action received ${signal}`));
  });
  try {
    run = await createRun(context, ports, abort.signal);
    publishRunOutputs(context, run, ports);
    run = await followRun(context, run, ports, abort.signal);
    completed = true;
    publishTerminalOutputs(context, run, ports);
    if (run.conclusion !== "success") throw conclusionError(run);
    ports.notice(`Amika command run ${run.id} completed successfully.`);
    return run;
  } finally {
    removeSignalListeners();
    if (!completed) await cancel();
  }
}
function parseActionContext(env, event, token = requireEnvironment(env, "AMIKA_TOKEN")) {
  const command = requireInput(env, "command", false);
  const sandbox = optionalInput(env, "sandbox");
  const reuseBranchSandbox = booleanInput(env, "reuse-branch-sandbox", true);
  const fallbackSandboxName = optionalInput(env, "fallback-sandbox-name");
  if (sandbox && reuseBranchSandbox) {
    throw new Error("sandbox requires reuse-branch-sandbox to be false");
  }
  if (sandbox && fallbackSandboxName) {
    throw new Error("sandbox cannot be combined with fallback-sandbox-name");
  }
  if (fallbackSandboxName) validateSandboxName(fallbackSandboxName);
  const workingDirectory = optionalInput(env, "working-directory") ?? ".";
  validateWorkingDirectory(workingDirectory);
  const timeoutMinutes = integerInput(env, "timeout-minutes", 60, 1, 1440);
  const amikaUrl = parseAmikaUrl(optionalInput(env, "amika-url"));
  const repositoryName = requireEnvironment(env, "GITHUB_REPOSITORY");
  const [owner, name, extra] = repositoryName.split("/");
  if (!owner || !name || extra) {
    throw new Error("GITHUB_REPOSITORY must have the form owner/name");
  }
  const repositoryId = String(
    env.GITHUB_REPOSITORY_ID ?? event.repository?.id ?? ""
  );
  if (!/^\d+$/.test(repositoryId)) {
    throw new Error("GitHub repository ID is missing or invalid");
  }
  const sourceSha = requireEnvironment(env, "GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("GITHUB_SHA must be a lowercase 40-character commit SHA");
  }
  const pullRequest = parsePullRequest(event);
  if (pullRequest && pullRequest.head_repository_id !== repositoryId) {
    throw new Error("Fork pull requests are not supported by this Action");
  }
  const headBranch = parseHeadBranch(env, event);
  const runId = requireEnvironment(env, "GITHUB_RUN_ID");
  const runAttempt = parsePositiveInteger(
    requireEnvironment(env, "GITHUB_RUN_ATTEMPT"),
    "GITHUB_RUN_ATTEMPT"
  );
  const jobKey = optionalInput(env, "job-key") ?? [
    requireEnvironment(env, "GITHUB_JOB"),
    env.GITHUB_ACTION ?? "action",
    env.RUNNER_NAME ?? "runner"
  ].join(":");
  if (jobKey.length > 255)
    throw new Error("GitHub job key exceeds 255 characters");
  return {
    token,
    amikaUrl,
    command,
    sandbox,
    reuseBranchSandbox,
    fallbackSandboxName,
    workingDirectory,
    timeoutSeconds: timeoutMinutes * 60,
    repository: {
      id: repositoryId,
      owner,
      name,
      url: event.repository?.clone_url ?? `https://github.com/${owner}/${name}.git`
    },
    sourceSha,
    gitRef: requireEnvironment(env, "GITHUB_REF"),
    headBranch,
    pullRequest,
    workflow: {
      ref: requireEnvironment(env, "GITHUB_WORKFLOW_REF"),
      run_id: runId,
      run_attempt: runAttempt,
      job_key: jobKey
    },
    idempotencyKey: createHash("sha256").update(`${repositoryId}:${runId}:${runAttempt}:${jobKey}`).digest("hex")
  };
}
async function createRun(context, ports, signal) {
  const body = {
    idempotency_key: context.idempotencyKey,
    ...context.sandbox ? { sandbox: context.sandbox } : {},
    reuse_branch_sandbox: context.reuseBranchSandbox,
    ...context.fallbackSandboxName ? { fallback_sandbox_name: context.fallbackSandboxName } : {},
    repository: context.repository,
    source_sha: context.sourceSha,
    git_ref: context.gitRef,
    head_branch: context.headBranch,
    ...context.pullRequest ? { pull_request: context.pullRequest } : {},
    workflow: context.workflow,
    command: context.command,
    working_directory: context.workingDirectory,
    timeout_seconds: context.timeoutSeconds
  };
  return requestJson(
    context,
    GITHUB_ACTION_COMMAND_RUN_API_PATH,
    { method: "POST", body: JSON.stringify(body) },
    ports,
    signal
  );
}
async function followRun(context, initialRun, ports, signal) {
  let run = initialRun;
  let cursor = 0;
  const deadline = ports.now() + context.timeoutSeconds * 1e3 + COMPLETION_GRACE_MS;
  while (ports.now() < deadline) {
    const events = await requestJson(
      context,
      `${COMMAND_RUN_API_PATH}/${encodeURIComponent(run.id)}/events?after=${cursor}&limit=100`,
      { method: "GET" },
      ports,
      signal
    );
    for (const event of events.items) {
      if (event.sequence <= cursor) continue;
      relayEvent(event, ports);
      cursor = event.sequence;
    }
    if (events.next_sequence > cursor) cursor = events.next_sequence;
    if (events.items.length === 100) continue;
    run = await requestJson(
      context,
      `${COMMAND_RUN_API_PATH}/${encodeURIComponent(run.id)}`,
      { method: "GET" },
      ports,
      signal
    );
    publishSandboxOutputs(context, run, ports);
    if (run.status === "completed") return run;
    await ports.sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error("Timed out waiting for Amika to finish command-run cleanup");
}
async function cancelRun(context, runId, ports) {
  await requestJson(
    context,
    `${COMMAND_RUN_API_PATH}/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
    ports,
    new AbortController().signal
  );
}
async function requestJson(context, path, init, ports, signal) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_HTTP_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await ports.fetch(`${context.amikaUrl}${path}`, {
        ...init,
        signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${context.token}`,
          "Content-Type": "application/json",
          "User-Agent": "amika-run-in-sandbox-action/0.0.1",
          ...init.headers
        }
      });
      if (response.ok) return await response.json();
      const responseBody = await response.text().catch(() => "");
      const error = new Error(
        `Amika API ${response.status}: ${responseBody || response.statusText}`
      );
      if (response.status < 500 && response.status !== 429) {
        throw new PermanentHttpError(error.message);
      }
      lastError = error;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PermanentHttpError) throw error;
      lastError = error;
    }
    if (attempt < MAX_HTTP_ATTEMPTS) {
      await ports.sleep(250 * 2 ** (attempt - 1), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
function relayEvent(event, ports) {
  if (event.stream === "stdout") {
    ports.stdout(event.content);
    return;
  }
  ports.stderr(event.content);
}
function publishRunOutputs(context, run, ports) {
  ports.setOutput("run-id", run.id);
  ports.setOutput(
    "run-url",
    `${context.amikaUrl}${COMMAND_RUN_API_PATH}/${encodeURIComponent(run.id)}`
  );
  publishSandboxOutputs(context, run, ports);
}
function publishSandboxOutputs(context, run, ports) {
  if (!run.sandbox_id) return;
  ports.setOutput("sandbox-id", run.sandbox_id);
  if (run.sandbox_name) ports.setOutput("sandbox-name", run.sandbox_name);
  ports.setOutput(
    "sandbox-url",
    `${context.amikaUrl}/sandbox/${encodeURIComponent(run.sandbox_id)}`
  );
}
function publishTerminalOutputs(context, run, ports) {
  publishSandboxOutputs(context, run, ports);
  if (run.conclusion) ports.setOutput("conclusion", run.conclusion);
  if (run.exit_code !== null)
    ports.setOutput("exit-code", String(run.exit_code));
}
function conclusionError(run) {
  switch (run.conclusion) {
    case "failure":
      return new Error(
        `Remote command failed with exit code ${run.exit_code ?? "unknown"}`
      );
    case "cancelled":
      return new Error("Remote command was cancelled");
    case "timed_out":
      return new Error("Remote command timed out");
    case "error":
      return new Error("Amika could not complete the remote command");
    case null:
      return new Error("Completed Amika command run has no conclusion");
    case "success":
      return new Error("Unexpected successful conclusion error");
    default:
      return assertNever(run.conclusion);
  }
}
function parsePullRequest(event) {
  if (!event.pull_request) return void 0;
  const number = event.pull_request.number;
  const headRepositoryId = String(event.pull_request.head?.repo?.id ?? "");
  if (!Number.isInteger(number) || (number ?? 0) <= 0 || !/^\d+$/.test(headRepositoryId)) {
    throw new Error("GitHub pull request context is incomplete");
  }
  return { number, head_repository_id: headRepositoryId };
}
function parseHeadBranch(env, event) {
  const branch = event.pull_request ? event.pull_request.head?.ref : requireBranchWorkflowRef(env);
  if (!branch || branch.startsWith("refs/heads/")) {
    throw new Error("GitHub head branch is missing or invalid");
  }
  return branch;
}
function requireBranchWorkflowRef(env) {
  if (requireEnvironment(env, "GITHUB_REF_TYPE") !== "branch") {
    throw new Error("Run in an Amika sandbox requires a GitHub branch ref");
  }
  return requireEnvironment(env, "GITHUB_REF_NAME");
}
function parseAmikaUrl(value) {
  const url = new URL(value ?? DEFAULT_AMIKA_URL);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("amika-url must use http or https");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "amika-url must be an origin without a path, query, or fragment"
    );
  }
  return url.origin;
}
function validateWorkingDirectory(value) {
  if (!value || value.startsWith("/") || value.split("/").some((component) => component === "..")) {
    throw new Error(
      "working-directory must be relative and cannot traverse its parent"
    );
  }
}
function validateSandboxName(value) {
  const labels = value.split(".");
  if (value.length > 253 || labels.some(
    (label) => label.length === 0 || label.length > 63 || !/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")
  )) {
    throw new Error("fallback-sandbox-name must be a lowercase DNS hostname");
  }
}
function requireInput(env, name, trim = true) {
  const value = env[inputEnvironmentName(name)];
  if (!value || !value.trim()) throw new Error(`Input ${name} is required`);
  return trim ? value.trim() : value;
}
function optionalInput(env, name) {
  const value = env[inputEnvironmentName(name)]?.trim();
  return value || void 0;
}
function booleanInput(env, name, defaultValue) {
  const value = optionalInput(env, name);
  if (value === void 0) return defaultValue;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`Input ${name} must be true or false`);
}
function integerInput(env, name, defaultValue, minimum, maximum) {
  const value = optionalInput(env, name);
  if (value === void 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Input ${name} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return parsed;
}
function requireEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
function inputEnvironmentName(name) {
  return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function assertNever(value) {
  throw new Error(`Unexpected remote conclusion: ${String(value)}`);
}
var PermanentHttpError = class extends Error {
};

// src/index.ts
async function main() {
  const ports = createPorts();
  try {
    await runAction(process.env, readGithubEvent(process.env), ports);
  } catch (error) {
    process.stderr.write(
      `::error::${escapeWorkflowCommand(errorMessage2(error))}
`
    );
    process.exitCode = 1;
  }
}
function createPorts() {
  return {
    fetch,
    now: Date.now,
    sleep,
    stdout: (content) => process.stdout.write(content),
    stderr: (content) => process.stderr.write(content),
    maskSecret: (secret) => {
      process.stdout.write(`::add-mask::${escapeWorkflowCommand(secret)}
`);
    },
    setOutput: writeOutput,
    notice: (message) => {
      process.stdout.write(`::notice::${escapeWorkflowCommand(message)}
`);
    },
    warning: (message) => {
      process.stderr.write(`::warning::${escapeWorkflowCommand(message)}
`);
    },
    onSignal: (handler) => {
      const onSigint = () => handler("SIGINT");
      const onSigterm = () => handler("SIGTERM");
      process.once("SIGINT", onSigint);
      process.once("SIGTERM", onSigterm);
      return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
    }
  };
}
function readGithubEvent(env) {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) throw new Error("GITHUB_EVENT_PATH is required");
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) throw new Error("GITHUB_OUTPUT is required");
  const delimiter = `amika_${crypto.randomUUID()}`;
  appendFileSync(
    path,
    `${name}<<${delimiter}
${value}
${delimiter}
`,
    "utf8"
  );
}
function sleep(milliseconds, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
void main();
//# sourceMappingURL=index.js.map
