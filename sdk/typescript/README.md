# @amika/sdk

Run coding-agent work in remote development environments without installing or
running the agent on your application's machine. Create a
**rig** (an Amika cloud development environment), wait for its setup to finish,
and send a prompt. Typed resources keep lifecycle operations next to the data
returned by the API, with field documentation available in your editor.

The SDK requires Node 18 or later and an [Amika account](https://app.amika.dev/signup)
with an API key. Complete repository access during onboarding and store a Claude
credential through Amika Settings or the
[CLI credential workflow](https://github.com/gofixpoint/amika/blob/main/docs/secrets.md#claude-code-credentials).
Your Amika API key authenticates SDK requests; the Claude credential lets the
agent run inside the rig. The SDK does not discover local credentials or Git
repositories automatically.

## Install and run

```sh
npm install @amika/sdk
```

Export `AMIKA_API_KEY`, replace the repository URL with one your account can
access, and run this TypeScript with your application's TypeScript toolchain or
`npx tsx example.ts`:

```ts
import { AmikaClient } from "@amika/sdk";

const client = new AmikaClient({ apiKey: process.env.AMIKA_API_KEY! });
const rig = await client.rigs.create({
  name: "hello-amika",
  repoUrl: "https://github.com/your-org/your-repo",
  agentCredentials: [{ kind: "claude" }],
});
console.log(`Created rig ${rig.name}`);

await rig.wait();
const turn = await rig.send({
  agent: "claude",
  newSession: true,
  message: "Inspect this repository and reply with a short summary",
});
console.log(turn.response);
if (turn.isError) throw new Error(turn.response);

// This summary-only example is finished with the rig.
await rig.delete();
```

Creation returns initial metadata before setup finishes. `wait()` resolves when
the rig is running and setup succeeded. Agent failures can return `isError: true`
with failure details in `response`, even when the HTTP request succeeds.

This example leaves the rig available if waiting or sending fails. Inspect it
through Amika or `client.rigs.get(name)` and delete it when you are finished.
Omitting `agentCredentials` injects no agent credentials; `{ kind: "claude" }`
asks the server to select a stored Claude credential.

## Fetch a rig, or construct a handle

`get()` makes a request immediately and rejects if the rig is missing or
inaccessible. It returns stopped rigs too, without starting them or waiting.

```ts
const rig = await client.rigs.get("dev");
console.log(rig.status);
```

`handle()` creates a **RigHandle** from a name or ID without a request or an
existence check. It has operations but no fetched metadata. `fetch()` and
`wait()` return a **Rig**, which includes metadata and the same operations.

```ts
const handle = client.rigs.handle("dev"); // No request or connection.
await handle.start(); // Request a start.
const rig = await handle.wait(); // Wait for running + setup success.

await rig.stop();
await rig.wait({ status: "stopped" });
```

For a rig that is already starting or running, `await client.rigs.getAndWait("dev")`
fetches and waits for readiness in one call. It includes the initial fetch in
the wait deadline. `get()` returns an ordinary promise: await it before calling
resource methods.

Fetched data is an observation rather than a live view. `rig.refresh()` and
`rig.wait()` update and return the same object. After fetching, operations use
the rig's ID so a later rename does not change their target. `rig.services` is
an array of fetched service summaries; service operations live on
`client.services`.

## Waiting and errors

Rig waits poll every 3 seconds and have a 15-minute total deadline by default.
The deadline includes token loading, HTTP requests, and poll delays. Waiting
never creates or starts a rig. HTTP and transport failures, including 404,
propagate immediately without retries.

```ts
import { AmikaHTTPError, AmikaWaitError } from "@amika/sdk";

try {
  await client.rigs.getAndWait("dev", {
    status: "running",
    setupStatus: "ok",
    pollMs: 1_000,
    maxWaitMs: 120_000,
  });
} catch (error) {
  if (error instanceof AmikaWaitError) {
    console.error(error.reason, error.status, error.setupStatus);
  } else if (error instanceof AmikaHTTPError) {
    console.error(error.statusCode, error.userMessage());
  } else {
    throw error;
  }
}
```

`AmikaWaitError.reason` is `provisioning`, `setup`, or `timeout`. Its fields
record the last observed rig state; `rigId` is empty if the first fetch never
completed. Waiting for `running` also requires successful setup by default.
Waiting for `stopped` accepts `suspended` and does not check setup by default.
You can supply an array of target statuses; any listed status matches. If the
array includes `running`, successful setup is required even when a different
listed status matches.

## Send and continue agent chats

`client.agentSessions.send()` can continue a chat by `sessionId`, target an
existing rig by `rigId`, or let the server create a rig. `repoUrl` is used only
when a rig must be created. `rig.send()` supplies the rig reference for you.
Both buffered and streaming sends have a 10-minute client timeout.
To choose which credentials a rig receives, create it with `agentCredentials`
before sending, as in the first example. The send request has no credential
selection option.

```ts
const turn = await client.agentSessions.send({
  message: "Summarize the repository",
  rigId: rig.id,
  agent: "claude",
});
if (turn.isError) throw new Error(turn.response);

const chat = await client.agentSessions.get(turn.sessionId);
await chat.sendStream(
  { message: "Explain the test setup" },
  { onDelta: (text) => process.stdout.write(text) },
);
await chat.refresh(); // Reload the transcript after sending.
```

Streaming calls await callbacks in order and return the completed turn.
`onStatus(phase, rigId)` reports lifecycle milestones; the ID can be empty
before a rig exists. `onDelta(text)` reports incremental reply text. A rejected
callback fails the send. The server can end a stream before the client timeout;
if it ends without a terminal result, the SDK throws. Inspect the chat before
retrying because the turn may still have completed.

`agentSessions.list({ limit })` returns `{ sessions, total }`, newest first.
Keep `total` when displaying a partial list. `agentSessions.get(id)` returns a
chat with its transcript and bound `send`, `sendStream`, and `refresh` methods.
Chat transcripts are stored on the server and can outlive their rigs; keeping
a chat record does not keep its rig or filesystem alive.

Use `client.rigSessions` only when you need to create or update session status
and metadata yourself. Creating one of these records does not send a prompt or
create a chat transcript. Use `client.agentSessions` for agent conversations.

## Snapshots

A snapshot captures a rig's filesystem for later rig creation. Capture returns
before it finishes; `snapshot.wait()` polls until `active`, rejecting on failure
or timeout. Snapshot waits default to the same 3-second poll interval and
15-minute deadline. Snapshot handles also support `fetch()` and `delete()`;
fetched snapshots add `refresh()`.

```ts
const snapshot = await client.snapshots.create({
  rigRef: "dev",
  name: "project-base",
  mode: "full",
});
await snapshot.wait();
// snapshot.snapshot is the saved snapshot's slug, such as "project-base".
const fork = await client.rigs.create({ snapshot: snapshot.snapshot });
```

Choose capture mode deliberately. `full` keeps the source rig and captures its
complete filesystem, including credentials. The default, `scrub_and_delete`,
removes Amika-injected secrets, captures the cleaned filesystem, and deletes the
source rig. `client.snapshots.previewScrub(rigRef)` previews affected paths and
environment names without returning secret values. Snapshot failures and
expired waits throw `AmikaError`; HTTP failures throw `AmikaHTTPError`.

## Configuration

`baseUrl` defaults to `https://app.amika.dev`. An override is the origin without
`/api/v0beta1`; the SDK appends that prefix. The SDK does not read
`AMIKA_API_URL` or `AMIKA_API_KEY` itself.

Provide exactly one of `apiKey`, `accessToken`, or `tokenSource`:

```ts
const client = new AmikaClient({
  baseUrl: "https://app.staging-amika.dev",
  tokenSource: { token: async () => getTokenFromYourSecretManager() },
  // fetch: customFetch, // Optional test or runtime override.
});
```

`getTokenFromYourSecretManager` represents your credential-loading code. The
SDK calls `token()` for each request. Static credentials must be non-empty.
Ordinary requests have a 30-second timeout; agent sends use 10 minutes.

## API reference in your editor

Import resource interfaces and request, response, and option types directly
from `@amika/sdk`. Hover fields for defaults and semantics, or use Go to
Definition. The package includes declarations, declaration maps, and source.

| Collection                | Methods                                           |
| ------------------------- | ------------------------------------------------- |
| `client.rigs`             | `create`, `list`, `get`, `handle`, `getAndWait`   |
| `client.agentSessions`    | `send`, `sendStream`, `list`, `get`               |
| `client.snapshots`        | `create`, `list`, `get`, `handle`, `previewScrub` |
| `client.services`         | `list`, `create`, `replace`, `delete`             |
| `client.secrets`          | `list`, `create`, `update`                        |
| `client.agentCredentials` | `create`, `list`, `delete`                        |
| `client.repositories`     | `list`                                            |
| `client.rigSessions`      | `create`, `list`, `get`, `latest`, `update`       |

Services are published rig ports. Their creation and replacement automatically
reject ports outside 1–65535 and the reserved range 60899–60999. Secrets and
agent-credential listings return metadata, never secret values.

Public definitions are organized by domain under `src/`. Start with
[rig resources](src/rigs/rig.ts), [rig data and creation options](src/rigs/types.ts),
[agent chats](src/agent-sessions/types.ts), and [snapshots](src/snapshots/snapshot.ts).
Conversion between API JSON and SDK types is separate from these definitions.
Shared HTTP, event-stream parsing, validation, and polling code lives under
`src/internal/`.

## Migration from the flat API

Flat methods such as `createRig`, `getRig`, and `sendAgentSession` still work
but are deprecated. Prefer `client.rigs.create`, `client.rigs.get`, and
`client.agentSessions.send`. Sandbox-named methods and types also remain as
deprecated compatibility aliases. Existing objects typed with `Sandbox*` aliases
do not need to add the new resource methods or canonical rig field names.

The old `waitForRig`, `waitForRigStart`, and `waitForRigStop` helpers retain their
original behavior: checking provisioning state without checking setup and
without a total deadline. The old `waitForRigSnapshot` also retains its unbounded
wait. Use resource `.wait()` methods for bounded waits and rig setup checks.

Four runtime exports have been retired: `StaticTokenSource`,
`RESERVED_PORT_MIN`, `RESERVED_PORT_MAX`, and `validateServicePort`. Supply
`apiKey` or `accessToken` directly, or implement the exported `TokenSource`
interface. Service write methods perform port validation automatically.

Data keeps the SDK's existing camelCase field names, including compatibility
fields such as `sandboxId` on chat responses. Optional values may be `undefined`, while required
nullable fields explicitly contain `null`.

## Development

This package has its own pnpm workspace and lockfile. Run commands here:

```sh
pnpm install
pnpm ci
```

`pnpm test` runs offline mocked HTTP tests. `pnpm test:package` builds and checks
an installed-package layout, including exports, deprecated types, NodeNext and
Bundler resolution, hover documentation, definition navigation, and shipped
source maps. `pnpm ci` includes both checks plus linting and formatting.

Functional tests use a real server and can create billable resources. They are
excluded from unit tests and skipped unless `AMIKA_API_URL` is set. Production
hosts are blocked; use staging or an ephemeral deployment:

```sh
AMIKA_API_URL=https://app.staging-amika.dev \
AMIKA_API_TOKEN=amk_… \
pnpm test:functional
```

See [functional test helpers](test/functional/helpers.ts) for optional environment
settings. Rig tests clean up their rigs; generic-secret tests can leave secrets
because the current API has no generic-secret deletion endpoint.
