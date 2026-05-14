# @amika/sdk

TypeScript SDK for [Amika](https://github.com/gofixpoint/amika). Wraps the `amika` CLI as a subprocess and exposes typed builders for its commands.

The SDK is intentionally derived from the CLI surface, not from the HTTP API. The CLI is the source of truth for what Amika can do; the SDK gives you a typed Node API on top of it.

## Install

```bash
npm install @amika/sdk
```

You also need the `amika` binary on `PATH` (or pass an absolute path — see below). Install it from the project root:

```bash
curl -fsSL https://raw.githubusercontent.com/gofixpoint/amika/main/install.sh | bash
```

## Quick start

```ts
import { AmikaClient } from "@amika/sdk";

const amika = new AmikaClient();

const version = await amika.version();
console.log(version);

// Create a sandbox
await amika.sandbox.create({
  name: "dev-box",
  preset: "coder",
  git: true,
  yes: true,
});

// List sandboxes (returns raw stdout for now — see "Output parsing" below)
const list = await amika.sandbox.list();
console.log(list.stdout);

// Send a prompt to an agent
await amika.sandbox.agentSend({
  name: "dev-box",
  message: "Refactor the auth module",
  agent: "claude",
});

// Clean up
await amika.sandbox.delete({ names: ["dev-box"], deleteVolumes: true });
```

## Configuration

`AmikaClient` accepts the same options as the underlying `Runner`:

| Option             | Default   | Description                                                                |
| ------------------ | --------- | -------------------------------------------------------------------------- |
| `binary`           | `"amika"` | Path to the `amika` binary. Resolved via `PATH` if not absolute.           |
| `cwd`              | inherited | Working directory passed to the spawned process.                           |
| `env`              | inherited | Environment passed to the spawned process. Replaces the parent env when set. |
| `defaultTimeoutMs` | none      | Default per-call timeout. Override per call via `RunOptions.timeoutMs`.    |

Per-call `RunOptions` (second argument on every command method, or pass to `client.raw`):

- `cwd`, `env`, `timeoutMs` — same as above but per call.
- `stdin` — write a string to the child's stdin and close.
- `signal` — an `AbortSignal` that will `SIGTERM` the child when aborted.

## API surface

All command methods return a `RunResult`:

```ts
interface RunResult {
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

A non-zero exit code rejects with `AmikaCommandError` (still exposes `stdout`, `stderr`, and the `args`). Spawn failures (e.g. missing binary) reject with `AmikaBinaryNotFoundError`.

### `client.sandbox`

- `create(input)` — `amika sandbox create [...]`
- `list({ scope? })` — `amika sandbox list`
- `delete({ names, deleteVolumes?, keepVolumes? })`
- `start({ names })` / `stop({ names })`
- `agentSend({ name, message?, noWait?, workdir?, agent? })`

### `client.volume`

- `list()` — `amika volume list`
- `delete({ names, force? })`

### `client.auth`

- `status()` — `amika auth status`
- `extract({ exportShell?, homedir?, noOauth? })` — `amika auth extract`

### `client.raw(args, options?)`

Escape hatch for any command not yet wrapped. Returns the same `RunResult`.

```ts
await client.raw(["materialize", "--script", "./run.sh", "--workdir", ".", "--outdir", "out", "--destdir", "dest"]);
```

## Output parsing

This is v0. Commands like `sandbox list` and `volume list` currently print human-readable tables; the SDK returns the raw stdout. Once the CLI grows machine-readable output flags, the SDK will expose typed parsed results alongside the raw stream.

For now, `client.raw([...])` plus your own parsing is the recommended approach when you need structured data.

## Errors

```ts
import { AmikaCommandError, AmikaBinaryNotFoundError } from "@amika/sdk";

try {
  await amika.sandbox.delete({ names: ["does-not-exist"] });
} catch (err) {
  if (err instanceof AmikaCommandError) {
    console.error(err.exitCode, err.stderr);
  } else if (err instanceof AmikaBinaryNotFoundError) {
    console.error("install amika first:", err.binary);
  } else {
    throw err;
  }
}
```

## Development

```bash
cd sdk/typescript
npm install
npm run typecheck
npm test
npm run build
```

Tests use Node's built-in `node:test` runner and a fake `amika` binary, so no Docker or real CLI is required.
