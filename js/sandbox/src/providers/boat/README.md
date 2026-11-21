# boat provider

[boat](https://boat.dev) runs Ubuntu VMs ("sandboxes") in the EU. This
provider drives them through the boat REST API
(`https://boat.dev/api/v1`, spec at
<https://docs.boat.dev/openapi/boat-v1.yaml>) with the small client in
`internal/client.ts`. It does not use the `@boatdev/sdk` package.

## Configuration

| Variable       | Purpose                                           |
| -------------- | ------------------------------------------------- |
| `BOAT_ENABLED` | `true` turns the provider on                      |
| `BOAT_API_KEY` | A `boat_…` API key                                |
| `BOAT_API_URL` | Optional API base URL (`https://boat.dev/api/v1`) |

The key needs the `full-sandbox` scopes plus `sandbox.create`,
`sandbox.resume`, `sandbox.delete`, `host`, and `snapshot.write`.
`account.read` lets the provider list the account's sizes; without it,
callers fall back to their own size table.

## What a sandbox boots from

`CreateSandboxProviderInput.snapshot` is `ubuntu-24.04` (boat's one base
image) or the name of a saved snapshot in the account.

## How the contract maps to boat

- **User and home.** boat logs in as `user` and has no other login user.
  Create makes the `amika` rig user (home `/home/amika`, passwordless
  `sudo`) before it returns. Commands run as `amika` through `sudo`, and
  files are written through a staging file under `/home/user`, then piped
  into place as `amika` (`../shared/rig-user.ts`).
- **Size.** boat has four types: `small` (2 vCPU, 4 GiB), `default` (4/8),
  `large` (8/16), and `xlarge` (16/32). Any other size is refused.
  `provider.account.sizes()` asks `GET /limits` which types the account may
  start.
- **Deadline.** boat stops a sandbox at a fixed deadline that commands do
  not extend, so create asks for none (`ttlSeconds: null`). A free trial
  refuses that; there create asks for two hours, the most a trial allows.
  `autoStopInterval` is not used: boat has no idle timer.
- **Secrets.** Create sets `noEnv`, so the sandbox gets none of the boat
  account's own secrets or CLI key.
- **Stop and start.** `stop` saves the disk and frees the machine; `start`
  resumes it, maybe on a new machine. Running programs end.
- **Exec.** NDJSON stream, so output has no size cap. A command runs at
  most 10 minutes (exit code 124 after that). boat has no stdin; the
  provider stages the input as a file and pipes it in.
- **Services.** Each service port is hosted as a protected port, whose URL
  answers only with its `?_token=`. boat's API cannot unhost a port, so
  route reconcile only adds ports.
- **Snapshots.** Saved snapshots hold the disk only. Names follow boat's
  rules (`internal/names.ts`); the name is the bootable handle.
- **Not supported:** minted SSH access (boat cannot remove an SSH key it
  added) and auto-delete.

## Running the contract suite

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=boat \
TEST_SANDBOX_CONTRACT_SNAPSHOT=ubuntu-24.04 \
BOAT_API_KEY=boat_... \
pnpm --filter @amika/sandbox test:integration
```
