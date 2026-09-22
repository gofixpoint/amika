import { describe, expect, it, vi } from "vitest";

import {
  parseActionContext,
  runAction,
  type ActionPorts,
  type GithubEvent,
} from "./action.js";

const sha = "a".repeat(40);
const pullRequestHeadSha = "b".repeat(40);
const pullRequestEvent: GithubEvent = {
  repository: {
    id: 101,
    clone_url: "https://github.com/amika/example.git",
  },
  pull_request: {
    number: 42,
    head: {
      ref: "feature/one",
      sha: pullRequestHeadSha,
      repo: { id: 101 },
    },
  },
};

function baseEnv(): Record<string, string> {
  return {
    AMIKA_TOKEN: "secret-token",
    INPUT_COMMAND: "pnpm test\n",
    "INPUT_REUSE-BRANCH-SANDBOX": "true",
    GITHUB_REPOSITORY: "amika/example",
    GITHUB_REPOSITORY_ID: "101",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SHA: sha,
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_RUN_ID: "5001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF:
      "amika/example/.github/workflows/ci.yml@refs/heads/main",
    GITHUB_JOB: "test",
    GITHUB_ACTION: "amika",
    RUNNER_NAME: "GitHub Actions 1",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makePorts(responses: Response[]): ActionPorts & {
  output: Record<string, string>;
  stdoutText: string[];
  stderrText: string[];
} {
  const output: Record<string, string> = {};
  const stdoutText: string[] = [];
  const stderrText: string[] = [];
  return {
    fetch: vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected HTTP request");
      return response;
    }),
    now: () => 0,
    sleep: vi.fn(async (_milliseconds, signal) => signal.throwIfAborted()),
    stdout: (content) => stdoutText.push(content),
    stderr: (content) => stderrText.push(content),
    maskSecret: vi.fn(),
    setOutput: (name, value) => {
      output[name] = value;
    },
    notice: vi.fn(),
    warning: vi.fn(),
    onSignal: vi.fn(() => () => undefined),
    output,
    stdoutText,
    stderrText,
  };
}

describe("parseActionContext", () => {
  it("derives trusted pull request context and a stable key", () => {
    const first = parseActionContext(baseEnv(), pullRequestEvent);
    const second = parseActionContext(baseEnv(), pullRequestEvent);

    expect(first).toMatchObject({
      command: "pnpm test\n",
      reuseBranchSandbox: true,
      headBranch: "feature/one",
      repository: { id: "101", owner: "amika", name: "example" },
      sourceSha: pullRequestHeadSha,
      pullRequest: { number: 42, head_repository_id: "101" },
      workflow: { run_id: "5001", run_attempt: 1 },
    });
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it("accepts asynchronous PR comment reporting", () => {
    const context = parseActionContext(
      {
        ...baseEnv(),
        "INPUT_WAIT-FOR-COMPLETION": "false",
        "INPUT_REPORT-RESULT": "pr-comment",
      },
      pullRequestEvent,
    );

    expect(context).toMatchObject({
      waitForCompletion: false,
      reportResult: "pr-comment",
    });
  });

  it("requires pull request context for PR comment reporting", () => {
    expect(() =>
      parseActionContext(
        {
          ...baseEnv(),
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_REF_TYPE: "branch",
          GITHUB_REF_NAME: "main",
          "INPUT_REPORT-RESULT": "pr-comment",
        },
        { repository: pullRequestEvent.repository },
      ),
    ).toThrow("report-result pr-comment requires a pull request workflow");
  });

  it("rejects pull_request_target workflows", () => {
    expect(() =>
      parseActionContext(
        { ...baseEnv(), GITHUB_EVENT_NAME: "pull_request_target" },
        pullRequestEvent,
      ),
    ).toThrow("pull_request_target workflows are not supported");
  });

  it("accepts a named fallback with explicit branch reuse", () => {
    const context = parseActionContext(
      {
        ...baseEnv(),
        "INPUT_FALLBACK-SANDBOX-NAME": "ci.example.5001",
      },
      pullRequestEvent,
    );

    expect(context).toMatchObject({
      reuseBranchSandbox: true,
      fallbackSandboxName: "ci.example.5001",
    });
  });

  it("gives reruns and matrix identities distinct keys", () => {
    const original = parseActionContext(baseEnv(), pullRequestEvent);
    const rerun = parseActionContext(
      { ...baseEnv(), GITHUB_RUN_ATTEMPT: "2" },
      pullRequestEvent,
    );
    const matrix = parseActionContext(
      { ...baseEnv(), "INPUT_JOB-KEY": "test:node-24" },
      pullRequestEvent,
    );

    expect(
      new Set([
        original.idempotencyKey,
        rerun.idempotencyKey,
        matrix.idempotencyKey,
      ]),
    ).toHaveLength(3);
  });

  it("uses the canonical branch name for branch workflows", () => {
    const context = parseActionContext(
      {
        ...baseEnv(),
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "main",
      },
      { repository: pullRequestEvent.repository },
    );

    expect(context.pullRequest).toBeUndefined();
    expect(context.reuseBranchSandbox).toBe(true);
    expect(context.headBranch).toBe("main");
  });

  it("rejects unsafe or conflicting selection", () => {
    expect(() =>
      parseActionContext(
        { ...baseEnv(), INPUT_SANDBOX: "shared" },
        pullRequestEvent,
      ),
    ).toThrow("sandbox requires reuse-branch-sandbox to be false");
    expect(() =>
      parseActionContext(baseEnv(), {
        ...pullRequestEvent,
        pull_request: {
          number: 42,
          head: {
            ref: "feature/one",
            sha: pullRequestHeadSha,
            repo: { id: 202 },
          },
        },
      }),
    ).toThrow("Fork pull requests are not supported");
    expect(() =>
      parseActionContext(
        {
          ...baseEnv(),
          "INPUT_FALLBACK-SANDBOX-NAME": "CI/example",
        },
        pullRequestEvent,
      ),
    ).toThrow("fallback-sandbox-name must be a lowercase DNS hostname");
  });
});

describe("runAction", () => {
  it("masks the token, relays ordered output, and publishes links", async () => {
    const ports = makePorts([
      jsonResponse(
        {
          id: "scr_1",
          sandbox_id: null,
          status: "queued",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
      jsonResponse({
        items: [
          { sequence: 1, stream: "stdout", content: "hello\n" },
          { sequence: 2, stream: "stderr", content: "warning\n" },
        ],
        next_sequence: 2,
      }),
      jsonResponse({
        id: "scr_1",
        sandbox_id: "sbx_1",
        sandbox_name: "ci.example.5001",
        status: "completed",
        conclusion: "success",
        exit_code: 0,
      }),
      jsonResponse({
        items: [{ sequence: 3, stream: "stdout", content: "done\n" }],
        next_sequence: 3,
      }),
    ]);

    await expect(
      runAction(
        {
          ...baseEnv(),
          "INPUT_FALLBACK-SANDBOX-NAME": "ci.example.5001",
        },
        pullRequestEvent,
        ports,
      ),
    ).resolves.toMatchObject({
      conclusion: "success",
    });
    expect(ports.maskSecret).toHaveBeenCalledWith("secret-token");
    expect(ports.stdoutText).toEqual(["hello\n", "done\n"]);
    expect(ports.stderrText).toEqual(["warning\n"]);
    expect(vi.mocked(ports.fetch).mock.calls[0]?.[0]).toBe(
      "https://app.amika.dev/api/v0beta1/github-actions/sandbox-command-runs",
    );
    expect(
      JSON.parse(
        String(vi.mocked(ports.fetch).mock.calls[0]?.[1]?.body),
      ) as unknown,
    ).toMatchObject({
      reuse_branch_sandbox: true,
      fallback_sandbox_name: "ci.example.5001",
      head_branch: "feature/one",
      source_sha: pullRequestHeadSha,
      git_ref: "refs/pull/42/merge",
    });
    expect(vi.mocked(ports.fetch).mock.calls[1]?.[0]).toBe(
      "https://app.amika.dev/api/v0beta1/sandbox-command-runs/scr_1/events?after=0&limit=100",
    );
    expect(ports.output).toMatchObject({
      "run-id": "scr_1",
      "run-url": "https://app.amika.dev/api/v0beta1/sandbox-command-runs/scr_1",
      "sandbox-id": "sbx_1",
      "sandbox-name": "ci.example.5001",
      "sandbox-url": "https://app.amika.dev/sandbox/sbx_1",
      conclusion: "success",
      "exit-code": "0",
    });
  });

  it("returns after acceptance in asynchronous mode", async () => {
    const ports = makePorts([
      jsonResponse(
        {
          id: "scr_async",
          sandbox_id: null,
          sandbox_name: null,
          status: "queued",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
    ]);

    await expect(
      runAction(
        {
          ...baseEnv(),
          "INPUT_WAIT-FOR-COMPLETION": "false",
          "INPUT_REPORT-RESULT": "pr-comment",
        },
        pullRequestEvent,
        ports,
      ),
    ).resolves.toMatchObject({ id: "scr_async", status: "queued" });

    expect(ports.fetch).toHaveBeenCalledTimes(1);
    expect(ports.sleep).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        String(vi.mocked(ports.fetch).mock.calls[0]?.[1]?.body),
      ) as unknown,
    ).toMatchObject({ report_result: "pr-comment" });
  });

  it("retries an idempotent create after a transient failure", async () => {
    const ports = makePorts([
      new Response("unavailable", { status: 503 }),
      jsonResponse(
        {
          id: "scr_1",
          sandbox_id: null,
          status: "queued",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
      jsonResponse({ items: [], next_sequence: 0 }),
      jsonResponse({
        id: "scr_1",
        sandbox_id: null,
        status: "completed",
        conclusion: "success",
        exit_code: 0,
      }),
      jsonResponse({ items: [], next_sequence: 0 }),
    ]);

    await runAction(baseEnv(), pullRequestEvent, ports);

    const calls = vi.mocked(ports.fetch).mock.calls;
    expect(calls[0]?.[0]).toBe(calls[1]?.[0]);
    expect(calls[0]?.[1]?.body).toBe(calls[1]?.[1]?.body);
    expect(ports.sleep).toHaveBeenCalledWith(250, expect.any(AbortSignal));
  });

  it("does not retry rejected API requests", async () => {
    const ports = makePorts([
      new Response("invalid command", { status: 400 }),
      jsonResponse({ id: "unexpected" }),
    ]);

    await expect(runAction(baseEnv(), pullRequestEvent, ports)).rejects.toThrow(
      "Amika API 400: invalid command",
    );
    expect(ports.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failure", 3, "Remote command failed with exit code 3"],
    ["cancelled", null, "Remote command was cancelled"],
    ["timed_out", null, "Remote command timed out"],
    ["error", null, "Amika could not complete the remote command"],
  ] as const)("maps %s distinctly", async (conclusion, exitCode, message) => {
    const ports = makePorts([
      jsonResponse(
        {
          id: "scr_1",
          sandbox_id: null,
          status: "queued",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
      jsonResponse({ items: [], next_sequence: 0 }),
      jsonResponse({
        id: "scr_1",
        sandbox_id: null,
        status: "completed",
        conclusion,
        exit_code: exitCode,
      }),
      jsonResponse({ items: [], next_sequence: 0 }),
    ]);

    await expect(runAction(baseEnv(), pullRequestEvent, ports)).rejects.toThrow(
      message,
    );
    expect(ports.output.conclusion).toBe(conclusion);
  });

  it("requests cancellation when interrupted", async () => {
    let signalHandler: ((signal: NodeJS.Signals) => void) | undefined;
    const ports = makePorts([
      jsonResponse(
        {
          id: "scr_1",
          sandbox_id: null,
          status: "queued",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
      jsonResponse({ items: [], next_sequence: 0 }),
      jsonResponse({
        id: "scr_1",
        sandbox_id: null,
        status: "in_progress",
        conclusion: null,
        exit_code: null,
      }),
      jsonResponse(
        {
          id: "scr_1",
          sandbox_id: null,
          status: "in_progress",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
      jsonResponse(
        {
          id: "scr_1",
          sandbox_id: null,
          status: "in_progress",
          conclusion: null,
          exit_code: null,
        },
        202,
      ),
    ]);
    ports.onSignal = (handler) => {
      signalHandler = handler;
      return () => undefined;
    };
    ports.sleep = vi.fn(async (_milliseconds, signal) => {
      signalHandler?.("SIGTERM");
      signal.throwIfAborted();
    });

    await expect(runAction(baseEnv(), pullRequestEvent, ports)).rejects.toThrow(
      "SIGTERM",
    );
    await vi.waitFor(() => {
      const urls = vi
        .mocked(ports.fetch)
        .mock.calls.map(([url]) => String(url));
      expect(
        urls.filter((url) => url.endsWith("/scr_1/cancel")).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("masks the token before reporting invalid inputs", async () => {
    const ports = makePorts([]);
    const env = baseEnv();
    delete env.INPUT_COMMAND;

    await expect(runAction(env, pullRequestEvent, ports)).rejects.toThrow(
      "Input command is required",
    );
    expect(ports.maskSecret).toHaveBeenCalledWith("secret-token");
  });
});
