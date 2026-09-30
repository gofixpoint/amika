# @amika/sdk

Use [Amika](https://github.com/gofixpoint/amika) from TypeScript to create cloud development environments (rigs), wait for their setup to finish, and send work to a coding agent. The SDK calls the cloud API at `https://app.amika.dev/api/v0beta1`. A rig is also called a sandbox in older SDK versions and API fields.

## Install

```bash
npm install @amika/sdk
```

## Quick start

Save this as `example.ts` and run it with a TypeScript runner, for example
`npx tsx example.ts` (the SDK requires Node 18+). Export `AMIKA_API_KEY` first.
Replace the repository URL with one your Amika account can access.

```ts
import { AmikaClient } from "@amika/sdk";

const amika = new AmikaClient({
  apiKey: process.env.AMIKA_API_KEY!,
});

// Create a rig (returns immediately with state "initializing")
const rig = await amika.createRig({
  name: "hello-amika",
  repoUrl: "git@github.com:your-org/your-repo.git", // replace with your repository
  agentCredentials: [{ kind: "claude" }],
});
console.log(`Created rig "${rig.name}"`);

// Wait for running + successful setup (3s polls, 15-minute deadline).
await rig.wait();

// Send a prompt to an agent (HTTP timeout is 10 minutes for this endpoint)
const resp = await amika.sendAgentSession({
  rigId: rig.id,
  newSession: true,
  message: "Inspect this repository and reply with a short summary",
  agent: "claude",
});
console.log(`Agent Response: ${resp.response}`);
if (resp.isError) throw new Error(resp.response);

// Delete only after successful completion.
console.log(`Deleting rig "${rig.name}"`);
await rig.delete();
```

If waiting or sending fails, the example leaves the rig available for inspection.
Its name is printed before waiting; delete it afterward with
`amika rig delete <name> --force`. If your agent changes files, push or copy them
out before deleting the rig.

## Configuration

Export `AMIKA_API_KEY` with an API key from your Amika account before running the quick start. Connect your repository account and store an agent credential in Amika Settings. `{ kind: "claude" }` asks the server to select your default stored Claude credential. The SDK does not load environment variables or credential files itself.

`baseUrl` defaults to `https://app.amika.dev`. To use another server, set it to the origin without `/api/v0beta1`; the SDK appends that prefix. The SDK does not read `AMIKA_API_URL` automatically. Prefer `apiKey` for scripts:

```ts
const amika = new AmikaClient({
  baseUrl: "https://app.staging-amika.dev", // optional override
  apiKey: process.env.AMIKA_API_KEY!,
  // fetch: customFetch, // optional override for tests or polyfills
});
```

Provide **exactly one** of `apiKey`, `accessToken`, or `tokenSource`. TypeScript checks this, and the constructor also rejects missing, conflicting, or blank static credentials at runtime. Both static fields authenticate with `Authorization: Bearer …`.

For an access token or a dynamic credential source, use one of these alternatives:

```ts
const withAccessToken = new AmikaClient({
  accessToken: "your-access-token",
});
const withTokenSource = new AmikaClient({
  tokenSource: { token: async () => getTokenFromYourSecretManager() },
});
```

`getTokenFromYourSecretManager` represents your own credential-loading code. The SDK calls `token()` for each request.

## API surface

The "Deprecated alias" column lists older sandbox spellings that still work.

### Rigs

| Method                  | Endpoint                             | Deprecated alias            |
| ----------------------- | ------------------------------------ | --------------------------- |
| `listRigs()`            | `GET /rigs`                          | `listSandboxes()`           |
| `createRig(req)`        | `POST /rigs`                         | `createSandbox(req)`        |
| `getRig(name)`          | `GET /rigs/{name}`                   | `getSandbox(name)`          |
| `waitForRig(name)`      | polls `GET /rigs/{name}` until ready | `waitForSandbox(name)`      |
| `startRig(name)`        | `POST /rigs/{name}/start`            | `startSandbox(name)`        |
| `waitForRigStart(name)` | polls until ready                    | `waitForSandboxStart(name)` |
| `stopRig(name)`         | `POST /rigs/{name}/stop`             | `stopSandbox(name)`         |
| `waitForRigStop(name)`  | polls until `stopped`                | `waitForSandboxStop(name)`  |
| `deleteRig(name)`       | `DELETE /rigs/{name}`                | `deleteSandbox(name)`       |
| `listRepositories()`    | `GET /repositories`                  | —                           |

### Services

| Method                                   | Endpoint                                   | Deprecated alias                   |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `listRigServices(rigRef?)`               | `GET /rig-services`                        | `listSandboxServices(sandboxRef?)` |
| `createRigService(rigRef, req)`          | `POST /rigs/{ref}/services`                | `createSandboxService()`           |
| `putRigService(rigRef, serviceRef, req)` | `PUT /rigs/{ref}/services/{serviceRef}`    | `putSandboxService()`              |
| `deleteRigService(rigRef, serviceRef)`   | `DELETE /rigs/{ref}/services/{serviceRef}` | `deleteSandboxService()`           |

### Secrets

| Method                                | Endpoint                          |
| ------------------------------------- | --------------------------------- |
| `listSecrets()`                       | `GET /secrets`                    |
| `createSecret(req)`                   | `POST /secrets`                   |
| `updateSecret(id, req)`               | `PUT /secrets/{id}`               |
| `createProviderSecret(provider, req)` | `POST /secrets/{provider}`        |
| `listProviderSecrets(provider)`       | `GET /secrets/{provider}`         |
| `deleteProviderSecret(provider, id)`  | `DELETE /secrets/{provider}/{id}` |

### Agents and sessions

| Method                                  | Endpoint                                                  |
| --------------------------------------- | --------------------------------------------------------- |
| `agentSend(name, req)`                  | `POST /agent-sessions` with `sandbox_id` (10-min timeout) |
| `sendAgentSession(req)`                 | `POST /agent-sessions` (10-min timeout)                   |
| `sendAgentSessionStream(req, handlers)` | `POST /agent-sessions/stream` (SSE)                       |
| `listAgentSessions(limit?)`             | `GET /agent-sessions`                                     |
| `getAgentSession(sessionId)`            | `GET /agent-sessions/{sessionId}`                         |
| `createSession(name, req)`              | `POST /rigs/{name}/sessions`                              |
| `listSessions(name)`                    | `GET /rigs/{name}/sessions`                               |
| `getLatestSession(name)`                | `GET /rigs/{name}/sessions/latest` (null on 404)          |
| `getSession(name, sessionId)`           | `GET /rigs/{name}/sessions/{sessionId}`                   |
| `updateSession(name, sessionId, req)`   | `PATCH /rigs/{name}/sessions/{sessionId}`                 |

### Snapshots

| Method                       | Endpoint                           | Deprecated alias                 |
| ---------------------------- | ---------------------------------- | -------------------------------- |
| `listRigSnapshots(filters?)` | `GET /rig-snapshots`               | `listSandboxSnapshots(filters?)` |
| `createRigSnapshot(req)`     | `POST /rig-snapshots`              | `createSandboxSnapshot(req)`     |
| `getRigSnapshot(ref)`        | `GET /rig-snapshots/{ref}`         | `getSandboxSnapshot(ref)`        |
| `waitForRigSnapshot(ref)`    | polls until `active` or `failed`   | `waitForSandboxSnapshot(ref)`    |
| `getRigScrubPreview(ref)`    | `GET /rig-snapshots/scrub-preview` | `getSandboxScrubPreview(ref)`    |
| `deleteRigSnapshot(ref)`     | `DELETE /rig-snapshots/{ref}`      | `deleteSandboxSnapshot(ref)`     |

Fork a new rig from a captured snapshot by passing its slug as `snapshot` to `createRig({ snapshot })`.

Types are camelCased and translated to/from snake_case on the wire. See `src/types.ts` and `src/agent-sessions.ts` for the full set: `CreateRigRequest`, `RemoteRig`, `Secret`, `CreateProviderSecretRequest`, `AgentSendRequest`, `AgentSendResponse`, `Session`, `RigSnapshot`, `RigServiceResource`, `AgentSessionSendRequest`, `AgentSessionDetail`, etc.

### Nullability

Field optionality mirrors the Go client's struct tags, which in turn follow the API schema. Whether a field can go missing in TypeScript tracks whether it is a pointer in Go:

| Go field            | TypeScript          | Decoding                                                            |
| ------------------- | ------------------- | ------------------------------------------------------------------- |
| `string`            | `x: string`         | required, always present                                            |
| `string,omitempty`  | `x: string`         | may be omitted on the wire, and decodes to `""` exactly as Go does  |
| `*string`           | `x: string \| null` | always present, and `null` is meaningful (a rig with no repository) |
| `*string,omitempty` | `x?: string`        | `null` and absent both surface as `undefined`                       |

A non-pointer Go field always lands as a value, so `state` and `status` stay plain strings even though the schema marks them optional. Go cannot tell an omitted `status` from an empty one, and neither should a 1:1 mirror. Slices go the other way, being nilable in Go themselves: `[]string,omitempty` is `x?: string[]`.

Two fields sit outside this rule because they sit outside the schema. `containerId` and `image` are CLI-only extensions that the API never returns, so they are typed optional to say exactly that.

## Waiting and deleting

`createRig`, `getRig`, and `listRigs` return resources with `wait()` and `delete()`. Their sandbox aliases do too. Rig lookup, stop, and delete accept a name or ID; `rigRef` in other methods means that same reference. Each resource carries the usual data fields (`id`, `name`, `status`, `setupStatus`, and so on). Methods and client credentials are not included when the resource is serialized to JSON.

```ts
const rig = await amika.getRig("my-rig");
await rig.wait(); // running AND setupStatus === "ok"
await rig.wait({ pollMs: 1_000, maxWaitMs: 5 * 60_000 });

// Wait for a power-state change initiated separately:
await amika.stopRig(rig.id);
await rig.wait({ status: ["stopped", "suspended"] });
await rig.delete();
```

`wait()` polls immediately, then every **3 seconds**, with a **15-minute total deadline** including HTTP requests. It refreshes the same resource's fields and returns that resource. `pollMs` and `maxWaitMs` must be positive integer milliseconds no greater than 2,147,483,647.

A status array matches any listed value. When the targets include `running`, setup must also be `ok` by default, even if another listed status matches. For stopped/suspended targets, setup is ignored unless you explicitly pass `setupStatus: "ok"`. The API reports stopped rigs as `suspended`, so the SDK also accepts that status for a `stopped` target. Waiting does not start or stop a rig. `delete()` resolves when the DELETE request succeeds; it does not poll for disappearance.

Provisioning failures, setup failures when setup is required, and deadline expiry throw `AmikaWaitError`. HTTP failures throw `AmikaHTTPError`; other transport failures propagate. Failed requests are not retried. A missing setup status keeps polling until the deadline.

The older client-level `waitForRig`, `waitForRigStart`, and `waitForRigStop` retain their state-only checks, 3-second polling and unlimited total wait. `waitForRigSnapshot` retains its existing behavior too. Use resource `.wait()` when setup readiness and a deadline matter.

`RemoteRig` and `RemoteSandbox` remain plain data types. `Rig` and `Sandbox` add the methods; hand-built mocks of create/get/list methods must now provide `wait` and `delete`.

## Model and effort

Both buffered and streaming sends accept `model` and `effort`:

```ts
await amika.sendAgentSession({
  rigId: rig.id,
  agent: "claude",
  newSession: true,
  message: "Review this repository",
  model: "opus",
  effort: "high",
});
```

Omitting either field inherits the chat's setting (the agent's default for a new chat). Explicit `null` resets it to the agent's default. The server validates which models and effort levels the selected agent supports. Effort values are `low`, `medium`, `high`, `xhigh`, and `max`.

Continue a chat with its returned `sessionId`. For example, omitting `model` keeps
that chat's selection while `effort: null` clears its effort setting:

```ts
const first = await amika.sendAgentSession({
  rigId: rig.id,
  message: "Review this repository",
  model: "opus",
  effort: "high",
});
await amika.sendAgentSession({
  sessionId: first.sessionId,
  message: "Summarize the findings",
  effort: null,
});
```

## Streaming an agent turn

`sendAgentSessionStream` reads the SSE endpoint and resolves with the same response `sendAgentSession` returns, after forwarding progress to your handlers:

```ts
const result = await amika.sendAgentSessionStream(
  { message: "Add a CHANGELOG", repoUrl: "git@github.com:org/proj.git" },
  {
    onStatus: (phase, rigId) => console.error(`[${phase}] ${rigId}`),
    onDelta: (text) => process.stdout.write(text),
  },
);
console.log(`\nsession ${result.sessionId} on rig ${result.sandboxId}`);
```

The `phase` values are the server's own (`creating_sandbox`, `sandbox_ready`) and still say sandbox.

The server enforces a 300s ceiling on the request, below the client's 10-minute timeout. If it cuts the stream before a terminal frame, the call throws and the turn may still have completed — check `listAgentSessions()` for the session rather than assuming the work was lost.

## Errors

```ts
import { AmikaError, AmikaHTTPError, AmikaWaitError } from "@amika/sdk";

try {
  const rig = await amika.getRig("my-rig");
  await rig.wait();
} catch (err) {
  if (err instanceof AmikaWaitError) {
    console.error(err.reason, err.rigId, err.status, err.setupStatus);
    // reason: "provisioning", "setup", or "timeout"; fields show the last observation.
  } else if (err instanceof AmikaHTTPError) {
    console.error(err.statusCode, err.userMessage());
    // userMessage() parses { code/error_code, message } if present, else returns the raw body
  } else if (err instanceof AmikaError) {
    console.error(err.message);
  } else {
    throw err;
  }
}
```

`agentSend(name, req)` delegates to `sendAgentSession({ ...req, rigId: name })` and returns the same response. Read the answer from `response`, accounting from `usage`, and continue the durable chat with `sessionId`. Agent failures, including provider authentication failures, return `isError: true` with details in `response`; HTTP failures throw `AmikaHTTPError`.

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

The functional tests (named `*.functional.test.ts`, living under `test/functional/`) exercise the SDK against a real Amika server. They are excluded from `pnpm test`, which stays offline, and are skipped entirely when `AMIKA_API_URL` is unset. To run them:

```bash
AMIKA_API_URL=https://app.staging-amika.dev \
AMIKA_API_TOKEN=amk_… \
pnpm test:functional
```

**Production is banned.** These tests provision and tear down real resources, so pointing `AMIKA_API_URL` at a production host (`app.amika.dev` or `amika.dev`) aborts the run before any test executes. This is a hard ban with no override; always target staging (e.g. `https://app.staging-amika.dev`).

Optional env vars: `AMIKA_TEST_REPO_URL`, `AMIKA_TEST_PRESET`, `AMIKA_TEST_AGENT_NAME`, `AMIKA_TEST_AGENT_CREDENTIAL_NAME`, `AMIKA_TEST_AGENT_CREDENTIAL_TYPE`, `AMIKA_TEST_BRANCH`, `AMIKA_TEST_RIG_NAME_PREFIX`, `AMIKA_TEST_PROVIDER`, `AMIKA_TEST_RIG_PROVIDER`. Two of those fall back to a former spelling when unset: `AMIKA_TEST_RIG_PROVIDER` to `AMIKA_TEST_SANDBOX_PROVIDER`, and `AMIKA_TEST_RIG_NAME_PREFIX` to `AMIKA_TEST_SANDBOX_NAME_PREFIX`. `AMIKA_TEST_PROVIDER` names the AI provider and has no alias. See `test/functional/helpers.ts` for details.

The suite provisions a real rig and runs the full lifecycle (create → wait → list → get → sessions → agentSend → stop → start → delete), so a single run takes several minutes and creates billable resources. Rigs are cleaned up in `afterAll`, but the secrets API has no delete endpoint, so test-created secrets accumulate.

`org-resources.functional.test.ts` is the exception: it only reads org-scoped listings, so it provisions nothing and finishes in seconds. Run it alone with `pnpm test:functional org-resources`.
