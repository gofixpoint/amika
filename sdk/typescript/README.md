# @amika/sdk

TypeScript SDK for [Amika](https://github.com/gofixpoint/amika). A 1:1 port of the Go API client at `go/internal/apiclient`. Same method names, same input/output shapes (camelCased), same HTTP behavior — talks to the cloud API at `https://app.amika.dev/api/v0beta1`.

## Install

```bash
npm install @amika/sdk
```

## Quick start

```ts
import { AmikaClient } from "@amika/sdk";

const amika = new AmikaClient({
  baseUrl: process.env.AMIKA_API_URL ?? "https://app.amika.dev",
  accessToken: process.env.AMIKA_API_KEY!,
});

// Create a sandbox (returns immediately with state "initializing")
const sb = await amika.createSandbox({
  name: "hello-amika",
  provider: "daytona",
  repoUrl: "git@github.com:gofixpoint/example-repo.git",
  preset: "coder",
  agentCredentials: [{ kind: "claude" }],
});
console.log(`Created sandbox "${sb.name}"`);

// Wait until it's ready (polls every 3s, no timeout)
await amika.waitForSandbox(sb.name);

// Send a prompt to an agent (HTTP timeout is 10 minutes for this endpoint)
const resp = await amika.agentSend(sb.name, {
  message: "Write a hello_world.md file with Hello World! in it",
  agent: "claude",
});
console.log(`Agent Response: ${resp.result}`);

// Tear down
console.log(`Deleting sandbox "${sb.name}"`);
await amika.deleteSandbox(sb.name);
```

## Workflow helpers

These methods compose the existing sandbox APIs into common patterns. They are optional — the step-by-step flow above still works the same way.

### `createSandboxAndWait(req, wait?)`

Creates a sandbox and polls until it is ready. Equivalent to `createSandbox()` followed by `waitForSandbox()`.

```ts
const sandbox = await amika.createSandboxAndWait(
  {
    name: "dev-box",
    repoUrl: "git@github.com:org/proj.git",
    preset: "coder",
  },
  { timeoutMs: 10 * 60_000 },
);
```

### `withSandbox(req, fn, options?)`

Creates a sandbox, waits until it is ready, runs your callback, then deletes the sandbox. Cleanup runs even if the callback throws.

```ts
const sshDestination = await amika.withSandbox(
  {
    name: "dev-box",
    repoUrl: "git@github.com:org/proj.git",
    preset: "coder",
  },
  async (sandbox) => {
    const ssh = await amika.getSSH(sandbox.name);
    return ssh.sshDestination;
  },
);
```

Keep the sandbox after the callback:

```ts
await amika.withSandbox(
  { name: "dev-box", repoUrl: "git@github.com:org/proj.git" },
  async (sandbox) => {
    await amika.agentSend(sandbox.name, {
      message: "Set up the project",
      agent: "claude",
    });
  },
  { deleteOnExit: false },
);
```

### `runAgent(req, options?)`

Creates a sandbox, sends one agent message, and deletes the sandbox when finished.

```ts
const { result, sessionId } = await amika.runAgent({
  name: "dev-box",
  repoUrl: "git@github.com:org/proj.git",
  preset: "coder",
  message: "Refactor the auth module",
  agent: "claude",
  newSession: true,
});

console.log(result);
console.log(sessionId);
```

The same helpers are also exported as standalone functions:

```ts
import { createSandboxAndWait, withSandbox, runAgent } from "@amika/sdk";
```

## Configuration

```ts
new AmikaClient({
  baseUrl: "https://app.amika.dev",
  accessToken: "amk_…", // OR
  tokenSource: { token: () => "…" }, // implement your own (e.g., fetch from a secret manager)
  fetch: customFetch, // optional: override globalThis.fetch (testing, polyfills)
});
```

- `accessToken` and `tokenSource` are mutually exclusive; one is required.
- The SDK does **not** read `AMIKA_API_KEY` or any on-disk credential file. Callers source the token themselves.

## API surface

Methods on `AmikaClient` mirror Go's `*apiclient.Client` 1:1:

| Method                                | Endpoint                                              |
| ------------------------------------- | ----------------------------------------------------- |
| `listSandboxes()`                     | `GET /sandboxes`                                      |
| `createSandbox(req)`                  | `POST /sandboxes`                                     |
| `getSandbox(name)`                    | `GET /sandboxes/{name}`                               |
| `waitForSandbox(name)`                | polls `GET /sandboxes/{name}` until ready             |
| `getSSH(name)`                        | `POST /sandboxes/{name}/ssh`                          |
| `revokeSSH(name, token)`              | `DELETE /sandboxes/{name}/ssh`                        |
| `startSandbox(name)`                  | `POST /sandboxes/{name}/start`                        |
| `waitForSandboxStart(name)`           | polls until ready                                     |
| `stopSandbox(name)`                   | `POST /sandboxes/{name}/stop`                         |
| `waitForSandboxStop(name)`            | polls until `stopped`                                 |
| `deleteSandbox(name)`                 | `DELETE /sandboxes/{name}`                            |
| `listSecrets()`                       | `GET /secrets`                                        |
| `createSecret(req)`                   | `POST /secrets`                                       |
| `updateSecret(id, req)`               | `PUT /secrets/{id}`                                   |
| `createProviderSecret(provider, req)` | `POST /secrets/{provider}`                            |
| `listProviderSecrets(provider)`       | `GET /secrets/{provider}`                             |
| `deleteProviderSecret(provider, id)`  | `DELETE /secrets/{provider}/{id}`                     |
| `agentSend(name, req)`                | `POST /sandboxes/{name}/agent-send` (10-min timeout)  |
| `createSession(name, req)`            | `POST /sandboxes/{name}/sessions`                     |
| `listSessions(name)`                  | `GET /sandboxes/{name}/sessions`                      |
| `getLatestSession(name)`              | `GET /sandboxes/{name}/sessions/latest` (null on 404) |
| `getSession(name, sessionId)`         | `GET /sandboxes/{name}/sessions/{sessionId}`          |
| `updateSession(name, sessionId, req)` | `PATCH /sandboxes/{name}/sessions/{sessionId}`        |

Types are camelCased and translated to/from snake_case on the wire. See `src/types.ts` for the full set: `CreateSandboxRequest`, `RemoteSandbox`, `SSHInfo`, `Secret`, `CreateProviderSecretRequest`, `AgentSendRequest`, `AgentSendResponse`, `Session`, etc.

## Polling behavior

`waitForSandbox`, `waitForSandboxStart`, and `waitForSandboxStop` poll `getSandbox` every **3 seconds** with **no client-side timeout**, matching Go's `WaitForSandbox`. They throw `AmikaError` if the sandbox enters `failed` state, including the server's `errorMessage` when present.

### Wait options

Each wait method also accepts an optional second argument:

```ts
await amika.waitForSandbox(sb.name, {
  timeoutMs: 10 * 60_000, // optional client-side timeout
  pollIntervalMs: 5_000, // optional, default 3_000
  signal: abortController.signal, // optional cancellation
  onPoll: (sandbox) => {
    console.log(`sandbox is ${sandbox.state}`);
  },
});
```

The same options can be passed to workflow helpers through `wait` in `WorkflowOptions`:

```ts
await amika.withSandbox(
  { name: "dev-box", repoUrl: "git@github.com:org/proj.git" },
  async (sandbox) => {
    /* ... */
  },
  {
    wait: { timeoutMs: 10 * 60_000 },
    deleteOnExit: true,
  },
);
```

When `timeoutMs` is set, the wait methods throw `AmikaError` if the target state is not reached in time. When `signal` is aborted, they throw `AmikaError` with a cancellation message.

## Errors

```ts
import { AmikaError, AmikaHTTPError, extractAgentAuthError } from "@amika/sdk";

try {
  await amika.getSandbox("does-not-exist");
} catch (err) {
  if (err instanceof AmikaHTTPError) {
    console.error(err.statusCode, err.userMessage());
    // userMessage() parses { code/error_code, message } if present, else returns the raw body
  } else if (err instanceof AmikaError) {
    console.error(err.message);
  } else {
    throw err;
  }
}
```

`agentSend` automatically detects agent-side auth failures (e.g., Anthropic 401) and rewrites them to a friendlier `AmikaError` explaining how to recover.

## Development

```bash
cd sdk/typescript
pnpm install
pnpm typecheck
pnpm lint
pnpm formatcheck
pnpm test
pnpm build
```

Tests use [Vitest](https://vitest.dev) with mocked `fetch` — no network or external binaries required.

### Functional tests

`test/functional/` exercises the SDK against a real Amika server. They are skipped when `AMIKA_API_URL` is unset, so `pnpm test` stays offline. To run them:

```bash
AMIKA_API_URL=https://app.amika.dev \
AMIKA_API_TOKEN=amk_… \
pnpm test:functional
```

Optional env vars: `AMIKA_TEST_REPO_URL`, `AMIKA_TEST_PRESET`, `AMIKA_TEST_AGENT_NAME`, `AMIKA_TEST_AGENT_CREDENTIAL_NAME`, `AMIKA_TEST_AGENT_CREDENTIAL_TYPE`, `AMIKA_TEST_BRANCH`, `AMIKA_TEST_SANDBOX_NAME_PREFIX`, `AMIKA_TEST_PROVIDER`. See `test/functional/helpers.ts` for details.

The suite provisions a real sandbox and runs the full lifecycle (create → wait → list → get → SSH → sessions → agentSend → stop → start → delete), so a single run takes several minutes and creates billable resources. Sandboxes are cleaned up in `afterAll`, but the secrets API has no delete endpoint — test-created secrets accumulate.
