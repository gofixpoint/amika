# @amika/sdk

TypeScript SDK for [Amika](https://github.com/gofixpoint/amika). A 1:1 port of the Go API client at `go/internal/apiclient`. Same method names, same input/output shapes (camelCased), same HTTP behavior — talks to the cloud API at `https://app.amika.dev/api/v0beta1`.

## Install

```bash
npm install @amika/sdk
```

## Rig is the canonical name

A **rig** is what earlier releases of this SDK called a sandbox. Every rig-named
method and type is the real one; the sandbox-named twin beside it is a
deprecated alias that forwards to it, so existing code keeps working unchanged:

```ts
await amika.createRig({ name: "hello-amika" }); // canonical
await amika.createSandbox({ name: "hello-amika" }); // same call, deprecated name
```

The aliasing is exhaustive:

- **Methods** — `listSandboxes`, `createSandbox`, `getSandbox`, `waitForSandbox*`, `startSandbox`, `stopSandbox`, `deleteSandbox`, `*SandboxService*`, `*SandboxSnapshot*`, and `getSandboxScrubPreview` all delegate to their `Rig` counterparts and issue the same rig-named request.
- **Types** — every sandbox-named type still resolves, in one of three ways: `CreateSandboxRequest` is a plain alias of `CreateRigRequest`; `RemoteSandbox`, `SandboxSnapshot`, and `SandboxServiceResource` resolve to their rig type with the rig-spelled fields relaxed to optional (see below); and `CreateSandboxSnapshotRequest` is spelled out separately so `sandboxRef` stays required.
- **Fields** — a response from a type with a sandbox-named alias carries both spellings with the same value: `rig.rigPreset` and `rig.sandboxPreset`, `snapshot.sourceRigId` and `snapshot.sourceSandboxId`, `service.rigId` and `service.sandboxId`. On request objects either spelling works and a non-empty rig one wins, at all three sites that take a pair: `createRigSnapshot({ rigRef | sandboxRef })`, `sendAgentSession({ rigId | sandboxId })`, and `listRigSnapshots({ sourceRigId | sourceSandboxId })`.
- **Functional-test env vars** — `AMIKA_TEST_RIG_PROVIDER` and `AMIKA_TEST_RIG_NAME_PREFIX` fall back to `AMIKA_TEST_SANDBOX_PROVIDER` and `AMIKA_TEST_SANDBOX_NAME_PREFIX`.

The SDK populates both spellings on every value it returns, so reading either is
safe, and a mirror is declared exactly as its twin is: `rig.providerRigId`
matches `rig.providerSandboxId`, and `rig.rigPreset` is optional because
`rig.sandboxPreset` always was. Building one of these response
types by hand, as a test fixture does, is safe too: on a sandbox-named alias the
rig-spelled fields are optional, so a fixture written against 0.11 still
type-checks. `test/legacy-compat.test.ts` holds the package to that. The one
direction not promised is the reverse assignment: a value typed as the legacy
alias is not assignable to the strict rig type, since it need not carry the rig
fields.

`Session`, `AgentSessionSendResponse`, `AgentSessionSummary`, and
`AgentSessionDetail` are the exception: they keep their own names, so there is no
second name to relax and no way to have both a strict canonical field and a
constructible legacy one. Rather than leave the canonical spelling weaker-typed
than the deprecated one, they carry only the schema's `sandboxId`,
`sandboxName`, and `createdSandbox`. Those name a wire object with no rig
identity of its own, and the wire stays `sandbox_*` either way.

Three behavior changes are deliberate. A decoded value now carries the rig-spelled
mirrors as extra own keys — `providerRigId`, `rigPreset` and `rigSize` on a rig,
`sourceRigId`, `sourceRigName`, `rigPreset` and `rigSize` on a snapshot, `rigId`
on a service. Field access is unaffected, but a whole-object comparison sees
them, so `expect(rig).toEqual(fixtureFrom0_11)`, a snapshot test, or anything
keyed on `Object.keys` or `JSON.stringify` of a decoded value needs updating.

Second, `createRigSnapshot` and its
`createSandboxSnapshot` alias throw `AmikaError` when neither `rigRef` nor
`sandboxRef` names a source rig, including when both are the empty string. 0.11
sent `sandbox_ref: ""` and let the server reject it, so a caller whose ref came
from an unset variable now sees a client-side `AmikaError` instead of an
`AmikaHTTPError`. Catch `AmikaError` (the base of both) if you relied on that.

Third, the error text the SDK produces itself now says rig. `waitForRig` and its
`waitForSandbox` alias throw `rig provisioning failed` where 0.11 threw
`sandbox provisioning failed`, and likewise for `rig start failed`,
`rig stop failed`, `rig snapshot capture failed`, and the agent-send
authentication message. These are fallbacks, used only when the server reports a
failure with no `errorMessage` of its own, and the deprecated aliases produce the
new wording too because they forward to the rig methods. Code matching on the old
text needs updating; matching on `AmikaError` and reading `errorMessage` does not.

What is _not_ renamed is the wire format. The server's JSON schema still spells these fields `sandbox_id`, `sandbox_ref`, `sandbox_preset`, and so on, and the SDK sends and reads exactly those keys. Only the TypeScript surface moved to `rig`.

## Quick start

```ts
import { AmikaClient } from "@amika/sdk";

const amika = new AmikaClient({
  baseUrl: process.env.AMIKA_API_URL ?? "https://app.amika.dev",
  accessToken: process.env.AMIKA_API_KEY!,
});

// Create a rig (returns immediately with state "initializing")
const rig = await amika.createRig({
  name: "hello-amika",
  provider: "daytona",
  repoUrl: "git@github.com:gofixpoint/example-repo.git",
  preset: "coder",
  agentCredentials: [{ kind: "claude" }],
});
console.log(`Created rig "${rig.name}"`);

// Wait until it's ready (polls every 3s, no timeout)
await amika.waitForRig(rig.name);

// Send a prompt to an agent (HTTP timeout is 10 minutes for this endpoint)
const resp = await amika.agentSend(rig.name, {
  message: "Write a hello_world.md file with Hello World! in it",
  agent: "claude",
});
console.log(`Agent Response: ${resp.result}`);

// Tear down
console.log(`Deleting rig "${rig.name}"`);
await amika.deleteRig(rig.name);
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

Methods on `AmikaClient` mirror Go's `*apiclient.Client` 1:1. The "Deprecated alias" column names the pre-rig spelling, which still works.

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

| Method                                  | Endpoint                                         |
| --------------------------------------- | ------------------------------------------------ |
| `agentSend(name, req)`                  | `POST /rigs/{name}/agent-send` (10-min timeout)  |
| `sendAgentSession(req)`                 | `POST /agent-sessions` (10-min timeout)          |
| `sendAgentSessionStream(req, handlers)` | `POST /agent-sessions/stream` (SSE)              |
| `listAgentSessions(limit?)`             | `GET /agent-sessions`                            |
| `getAgentSession(sessionId)`            | `GET /agent-sessions/{sessionId}`                |
| `createSession(name, req)`              | `POST /rigs/{name}/sessions`                     |
| `listSessions(name)`                    | `GET /rigs/{name}/sessions`                      |
| `getLatestSession(name)`                | `GET /rigs/{name}/sessions/latest` (null on 404) |
| `getSession(name, sessionId)`           | `GET /rigs/{name}/sessions/{sessionId}`          |
| `updateSession(name, sessionId, req)`   | `PATCH /rigs/{name}/sessions/{sessionId}`        |

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

## Polling behavior

`waitForRig`, `waitForRigStart`, and `waitForRigStop` poll `getRig` every **3 seconds** with **no client-side timeout**, matching Go's `WaitForSandbox`. They throw `AmikaError` if the rig enters `failed` state, including the server's `errorMessage` when present. `waitForRigSnapshot` polls `getRigSnapshot` the same way, returning once the snapshot is `active` and throwing if it ends up `failed`.

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
import { AmikaError, AmikaHTTPError, extractAgentAuthError } from "@amika/sdk";

try {
  await amika.getRig("does-not-exist");
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
