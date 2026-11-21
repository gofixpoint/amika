# Runtime provider

[Runtime](https://withruntime.com) runs Firecracker microVMs ("sandboxes").
This provider drives them through the Runtime REST API
(`https://api.withruntime.com/v2`, spec at
<https://api.withruntime.com/v2/openapi.json>) with the small client in
`internal/client.ts`. It does not use the `withruntime` package.

## Configuration

| Variable          | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `RUNTIME_ENABLED` | `true` turns the provider on                          |
| `RUNTIME_API_KEY` | An `rtkey_…` bearer API key                           |
| `RUNTIME_API_URL` | Optional API base URL (`https://api.withruntime.com`) |

Key-pair keys (`rtsk_…`) sign every request, which this client does not
do; the provider refuses them.

## What a sandbox boots from

`CreateSandboxProviderInput.snapshot` is `runtime` (Runtime's default
image, Ubuntu 24.04), or an image (a name, `name:version`, or an id) such
as a version this provider captured.

## How the contract maps to Runtime

- **User and home.** Runtime logs in as `runtime` (or `root`). Create makes
  the `amika` rig user (home `/home/amika`, passwordless `sudo`) before it
  returns. Commands run as `amika` through `sudo`, and files are written
  through a staging file under `/workspace`, then piped into place as
  `amika` (`../shared/rig-user.ts`).
- **Size.** Free-form: `vcpu`, `memoryGB`, and `diskGB` as requested, up to
  the plan's per-machine limits.
- **Stop and start.** Runtime has no stopped state: `stop` pauses
  (`:pause`), `start` resumes (`:resume`). A pause reads as `stopped`.
  `autoStopInterval` sets the idle pause (`idlePauseSeconds`, 60 seconds to
  a day, or 0 for never); a command, file call, or preview visit wakes the
  sandbox.
- **Exec.** argv `bash -c`, streamed as NDJSON, at most 30 minutes (exit
  code 124 after that). When Runtime cuts a stream, the provider reads the
  rest from the process's output.
- **Services.** Each service port gets a private preview. Its URL carries a
  signed token as `?runtime_preview_token=`, valid for seven days; a
  refresh signs a new one.
- **Snapshots.** Capture saves the **disk only**, as the next version of an
  image (`:snapshot` with `image`). A plain Runtime snapshot also keeps
  memory, which a scrub cannot clean. The handle is the version's id.
- **Names.** Runtime sandbox names have undocumented rules, so create sends
  none; the exact name rides in the `amika-sandbox-name` label.
- **Not supported:** SSH (Runtime has none), auto-delete, and account sizes.

## Running the contract suite

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=runtime \
TEST_SANDBOX_CONTRACT_SNAPSHOT=runtime \
RUNTIME_API_KEY=rtkey_... \
pnpm --filter @amika/sandbox test:integration
```
