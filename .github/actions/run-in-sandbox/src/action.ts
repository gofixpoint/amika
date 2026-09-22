import { createHash } from "node:crypto";

const DEFAULT_AMIKA_URL = "https://app.amika.dev";
const COMMAND_RUN_API_PATH = "/api/v0beta1/sandbox-command-runs";
const GITHUB_ACTION_COMMAND_RUN_API_PATH =
  "/api/v0beta1/github-actions/sandbox-command-runs";
const MAX_HTTP_ATTEMPTS = 4;
const POLL_INTERVAL_MS = 1_000;
const COMPLETION_GRACE_MS = 5 * 60 * 1_000;

type Environment = Record<string, string | undefined>;
type Conclusion = "success" | "failure" | "cancelled" | "timed_out" | "error";
type ReportResult = "none" | "pr-comment";

export interface ActionPorts {
  fetch: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  stdout: (content: string) => void;
  stderr: (content: string) => void;
  maskSecret: (secret: string) => void;
  setOutput: (name: string, value: string) => void;
  notice: (message: string) => void;
  warning: (message: string) => void;
  onSignal: (handler: (signal: NodeJS.Signals) => void) => () => void;
}

export interface GithubEvent {
  repository?: {
    id?: number | string;
    clone_url?: string;
  };
  pull_request?: {
    number?: number;
    head?: {
      ref?: string;
      sha?: string;
      repo?: { id?: number | string };
    };
  };
}

export interface ParsedActionContext {
  token: string;
  amikaUrl: string;
  command: string;
  sandbox?: string;
  reuseBranchSandbox: boolean;
  fallbackSandboxName?: string;
  workingDirectory: string;
  timeoutSeconds: number;
  waitForCompletion: boolean;
  reportResult: ReportResult;
  repository: { id: string; owner: string; name: string; url: string };
  sourceSha: string;
  gitRef: string;
  headBranch: string;
  pullRequest?: { number: number; head_repository_id: string };
  workflow: {
    ref: string;
    run_id: string;
    run_attempt: number;
    job_key: string;
  };
  idempotencyKey: string;
}

interface CommandRun {
  id: string;
  sandbox_id: string | null;
  sandbox_name: string | null;
  status: "queued" | "in_progress" | "completed";
  conclusion: Conclusion | null;
  exit_code: number | null;
}

interface CommandRunEvent {
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  content: string;
}

interface EventsResponse {
  items: CommandRunEvent[];
  next_sequence: number;
}

export async function runAction(
  env: Environment,
  event: GithubEvent,
  ports: ActionPorts,
): Promise<CommandRun> {
  const token = requireEnvironment(env, "AMIKA_TOKEN");
  ports.maskSecret(token);
  const context = parseActionContext(env, event, token);
  const abort = new AbortController();
  let run: CommandRun | null = null;
  let completed = false;

  const cancel = async (): Promise<void> => {
    if (!run || completed) return;
    await cancelRun(context, run.id, ports).catch((error: unknown) => {
      ports.warning(
        `Could not request Amika cancellation: ${errorMessage(error)}`,
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
    if (!context.waitForCompletion) {
      completed = true;
      ports.notice(asynchronousNotice(run.id, context.reportResult));
      return run;
    }
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

export function parseActionContext(
  env: Environment,
  event: GithubEvent,
  token = requireEnvironment(env, "AMIKA_TOKEN"),
): ParsedActionContext {
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
  const timeoutMinutes = integerInput(env, "timeout-minutes", 60, 1, 1_440);
  const waitForCompletion = booleanInput(env, "wait-for-completion", true);
  const reportResult = reportResultInput(env);
  const amikaUrl = parseAmikaUrl(optionalInput(env, "amika-url"));

  const repositoryName = requireEnvironment(env, "GITHUB_REPOSITORY");
  const [owner, name, extra] = repositoryName.split("/");
  if (!owner || !name || extra) {
    throw new Error("GITHUB_REPOSITORY must have the form owner/name");
  }
  const repositoryId = String(
    env.GITHUB_REPOSITORY_ID ?? event.repository?.id ?? "",
  );
  if (!/^\d+$/.test(repositoryId)) {
    throw new Error("GitHub repository ID is missing or invalid");
  }
  const eventName = requireEnvironment(env, "GITHUB_EVENT_NAME");
  if (eventName === "pull_request_target") {
    throw new Error(
      "pull_request_target workflows are not supported by this Action",
    );
  }
  const sourceSha = event.pull_request
    ? event.pull_request.head?.sha
    : requireEnvironment(env, "GITHUB_SHA");
  if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      event.pull_request
        ? "pull_request.head.sha must be a lowercase 40-character commit SHA"
        : "GITHUB_SHA must be a lowercase 40-character commit SHA",
    );
  }

  const pullRequest = parsePullRequest(event);
  if (pullRequest && pullRequest.head_repository_id !== repositoryId) {
    throw new Error("Fork pull requests are not supported by this Action");
  }
  if (requiresPullRequest(reportResult) && !pullRequest) {
    throw new Error(
      "report-result pr-comment requires a pull request workflow",
    );
  }
  const headBranch = parseHeadBranch(env, event);

  const runId = requireEnvironment(env, "GITHUB_RUN_ID");
  const runAttempt = parsePositiveInteger(
    requireEnvironment(env, "GITHUB_RUN_ATTEMPT"),
    "GITHUB_RUN_ATTEMPT",
  );
  const jobKey =
    optionalInput(env, "job-key") ??
    [
      requireEnvironment(env, "GITHUB_JOB"),
      env.GITHUB_ACTION ?? "action",
      env.RUNNER_NAME ?? "runner",
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
    waitForCompletion,
    reportResult,
    repository: {
      id: repositoryId,
      owner,
      name,
      url:
        event.repository?.clone_url ??
        `https://github.com/${owner}/${name}.git`,
    },
    sourceSha,
    gitRef: requireEnvironment(env, "GITHUB_REF"),
    headBranch,
    pullRequest,
    workflow: {
      ref: requireEnvironment(env, "GITHUB_WORKFLOW_REF"),
      run_id: runId,
      run_attempt: runAttempt,
      job_key: jobKey,
    },
    idempotencyKey: createHash("sha256")
      .update(`${repositoryId}:${runId}:${runAttempt}:${jobKey}`)
      .digest("hex"),
  };
}

async function createRun(
  context: ParsedActionContext,
  ports: ActionPorts,
  signal: AbortSignal,
): Promise<CommandRun> {
  const body = {
    idempotency_key: context.idempotencyKey,
    ...(context.sandbox ? { sandbox: context.sandbox } : {}),
    reuse_branch_sandbox: context.reuseBranchSandbox,
    ...(context.fallbackSandboxName
      ? { fallback_sandbox_name: context.fallbackSandboxName }
      : {}),
    repository: context.repository,
    source_sha: context.sourceSha,
    git_ref: context.gitRef,
    head_branch: context.headBranch,
    ...(context.pullRequest ? { pull_request: context.pullRequest } : {}),
    workflow: context.workflow,
    command: context.command,
    working_directory: context.workingDirectory,
    timeout_seconds: context.timeoutSeconds,
    report_result: context.reportResult,
  };
  return requestJson<CommandRun>(
    context,
    GITHUB_ACTION_COMMAND_RUN_API_PATH,
    { method: "POST", body: JSON.stringify(body) },
    ports,
    signal,
  );
}

async function followRun(
  context: ParsedActionContext,
  initialRun: CommandRun,
  ports: ActionPorts,
  signal: AbortSignal,
): Promise<CommandRun> {
  let run = initialRun;
  let cursor = 0;
  const deadline =
    ports.now() + context.timeoutSeconds * 1_000 + COMPLETION_GRACE_MS;

  while (ports.now() < deadline) {
    cursor = await drainEvents(context, run.id, cursor, ports, signal);

    run = await requestJson<CommandRun>(
      context,
      `${COMMAND_RUN_API_PATH}/${encodeURIComponent(run.id)}`,
      { method: "GET" },
      ports,
      signal,
    );
    publishSandboxOutputs(context, run, ports);
    if (run.status === "completed") {
      await drainEvents(context, run.id, cursor, ports, signal);
      return run;
    }
    await ports.sleep(POLL_INTERVAL_MS, signal);
  }
  throw new Error("Timed out waiting for Amika to finish command-run cleanup");
}

async function drainEvents(
  context: ParsedActionContext,
  runId: string,
  initialCursor: number,
  ports: ActionPorts,
  signal: AbortSignal,
): Promise<number> {
  let cursor = initialCursor;
  while (true) {
    const events = await requestJson<EventsResponse>(
      context,
      `${COMMAND_RUN_API_PATH}/${encodeURIComponent(runId)}/events?after=${cursor}&limit=100`,
      { method: "GET" },
      ports,
      signal,
    );
    for (const event of events.items) {
      if (event.sequence <= cursor) continue;
      relayEvent(event, ports);
      cursor = event.sequence;
    }
    if (events.next_sequence > cursor) cursor = events.next_sequence;
    if (events.items.length < 100) return cursor;
  }
}

async function cancelRun(
  context: ParsedActionContext,
  runId: string,
  ports: ActionPorts,
): Promise<void> {
  await requestJson<CommandRun>(
    context,
    `${COMMAND_RUN_API_PATH}/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
    ports,
    new AbortController().signal,
  );
}

async function requestJson<T>(
  context: ParsedActionContext,
  path: string,
  init: RequestInit,
  ports: ActionPorts,
  signal: AbortSignal,
): Promise<T> {
  let lastError: unknown;
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
          ...init.headers,
        },
      });
      if (response.ok) return (await response.json()) as T;
      const responseBody = await response.text().catch(() => "");
      const error = new Error(
        `Amika API ${response.status}: ${responseBody || response.statusText}`,
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

function relayEvent(event: CommandRunEvent, ports: ActionPorts): void {
  if (event.stream === "stdout") {
    ports.stdout(event.content);
    return;
  }
  ports.stderr(event.content);
}

function publishRunOutputs(
  context: ParsedActionContext,
  run: CommandRun,
  ports: ActionPorts,
): void {
  ports.setOutput("run-id", run.id);
  ports.setOutput(
    "run-url",
    `${context.amikaUrl}${COMMAND_RUN_API_PATH}/${encodeURIComponent(run.id)}`,
  );
  publishSandboxOutputs(context, run, ports);
}

function publishSandboxOutputs(
  context: ParsedActionContext,
  run: CommandRun,
  ports: ActionPorts,
): void {
  if (!run.sandbox_id) return;
  ports.setOutput("sandbox-id", run.sandbox_id);
  if (run.sandbox_name) ports.setOutput("sandbox-name", run.sandbox_name);
  ports.setOutput(
    "sandbox-url",
    `${context.amikaUrl}/sandbox/${encodeURIComponent(run.sandbox_id)}`,
  );
}

function publishTerminalOutputs(
  context: ParsedActionContext,
  run: CommandRun,
  ports: ActionPorts,
): void {
  publishSandboxOutputs(context, run, ports);
  if (run.conclusion) ports.setOutput("conclusion", run.conclusion);
  if (run.exit_code !== null)
    ports.setOutput("exit-code", String(run.exit_code));
}

function conclusionError(run: CommandRun): Error {
  switch (run.conclusion) {
    case "failure":
      return new Error(
        `Remote command failed with exit code ${run.exit_code ?? "unknown"}`,
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

function parsePullRequest(
  event: GithubEvent,
): ParsedActionContext["pullRequest"] {
  if (!event.pull_request) return undefined;
  const number = event.pull_request.number;
  const headRepositoryId = String(event.pull_request.head?.repo?.id ?? "");
  if (
    !Number.isInteger(number) ||
    (number ?? 0) <= 0 ||
    !/^\d+$/.test(headRepositoryId)
  ) {
    throw new Error("GitHub pull request context is incomplete");
  }
  return { number: number!, head_repository_id: headRepositoryId };
}

function parseHeadBranch(env: Environment, event: GithubEvent): string {
  const branch = event.pull_request
    ? event.pull_request.head?.ref
    : requireBranchWorkflowRef(env);
  if (!branch || branch.startsWith("refs/heads/")) {
    throw new Error("GitHub head branch is missing or invalid");
  }
  return branch;
}

function requireBranchWorkflowRef(env: Environment): string {
  if (requireEnvironment(env, "GITHUB_REF_TYPE") !== "branch") {
    throw new Error("Run in an Amika sandbox requires a GitHub branch ref");
  }
  return requireEnvironment(env, "GITHUB_REF_NAME");
}

function parseAmikaUrl(value: string | undefined): string {
  const url = new URL(value ?? DEFAULT_AMIKA_URL);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("amika-url must use http or https");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "amika-url must be an origin without a path, query, or fragment",
    );
  }
  return url.origin;
}

function validateWorkingDirectory(value: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value.split("/").some((component) => component === "..")
  ) {
    throw new Error(
      "working-directory must be relative and cannot traverse its parent",
    );
  }
}

function validateSandboxName(value: string): void {
  const labels = value.split(".");
  if (
    value.length > 253 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    throw new Error("fallback-sandbox-name must be a lowercase DNS hostname");
  }
}

function requireInput(env: Environment, name: string, trim = true): string {
  const value = env[inputEnvironmentName(name)];
  if (!value || !value.trim()) throw new Error(`Input ${name} is required`);
  return trim ? value.trim() : value;
}

function optionalInput(env: Environment, name: string): string | undefined {
  const value = env[inputEnvironmentName(name)]?.trim();
  return value || undefined;
}

function booleanInput(
  env: Environment,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = optionalInput(env, name);
  if (value === undefined) return defaultValue;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error(`Input ${name} must be true or false`);
}

function asynchronousNotice(runId: string, reportResult: ReportResult): string {
  switch (reportResult) {
    case "none":
      return `Amika accepted command run ${runId}; it will continue asynchronously.`;
    case "pr-comment":
      return `Amika accepted command run ${runId}; the result will be posted to the pull request.`;
    default:
      return assertNever(reportResult);
  }
}

function requiresPullRequest(reportResult: ReportResult): boolean {
  switch (reportResult) {
    case "none":
      return false;
    case "pr-comment":
      return true;
    default:
      return assertNever(reportResult);
  }
}

function reportResultInput(env: Environment): ReportResult {
  const value = optionalInput(env, "report-result") ?? "none";
  switch (value) {
    case "none":
    case "pr-comment":
      return value;
    default:
      throw new Error("Input report-result must be none or pr-comment");
  }
}

function integerInput(
  env: Environment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = optionalInput(env, name);
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Input ${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function requireEnvironment(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function inputEnvironmentName(name: string): string {
  return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Action value: ${String(value)}`);
}

class PermanentHttpError extends Error {}
