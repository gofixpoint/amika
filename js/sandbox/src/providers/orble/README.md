# Orble provider

[Orble](https://orble.tech) runs Debian VMs ("boxes") that suspend when
idle and resume with their programs intact. This provider drives them
through the Orble REST API (`https://orble.tech/v1`) with the small client
in `internal/client.ts`. Orble publishes no API reference; the paths and
shapes follow its official SDK (`@orble/sdk`). The provider does not use
the SDK.

## Configuration

| Variable        | Purpose                                      |
| --------------- | -------------------------------------------- |
| `ORBLE_ENABLED` | `true` turns the provider on                 |
| `ORBLE_API_KEY` | An `orble_…` API key                         |
| `ORBLE_API_URL` | Optional API base URL (`https://orble.tech`) |

## What a box boots from

`CreateSandboxProviderInput.snapshot` is `debian-13` (Orble's own image)
or the name of a snapshot in the account.

## How the contract maps to Orble

- **Id.** A box is addressed by its name, which create picks
  (`internal/names.ts`), so the provider sandbox id is the box name.
- **User and home.** Orble logs in as `agent`. Create makes the `amika` rig
  user (home `/home/amika`, passwordless `sudo`) before it returns.
  Commands run as `amika` through `sudo`, and files go through a staging
  file under `/home/agent` (`../shared/rig-user.ts`).
- **Size.** Orble has three sizes: `s` (2 vCPU, 4 GiB), `m` (4/8), and `l`
  (8/16), each with a 64 GiB disk. Any other size is refused.
- **Stop and start.** Orble has no stop: `stop` suspends the box (memory
  and programs kept) and `start` resumes it. Orble also suspends an idle
  box after about 100 seconds, and a command, file call, or SSH login wakes
  it. The idle time cannot be set; an `autoStopInterval` of 0 keeps the box
  awake (`keep_awake`).
- **Exec.** `bash -c` through Orble's exec, which holds a request about 50
  seconds and then hands back a job to poll. A command runs at most 10
  minutes (exit code 124), keeps only the **last 64 KiB** of each stream,
  and does not stream. Orble has no stdin; the provider stages the input as
  a file and pipes it in.
- **Files.** Orble writes at most 8 MiB at a time, so a larger file goes in
  parts that a command joins. Reads go through a staged copy, read back in
  chunks, because command output is capped.
- **Not supported:**
  - Snapshots: an Orble snapshot always keeps memory and running programs,
    which a scrub before capture cannot clean.
  - Service URLs: a private port answers only a browser signed in to the
    Orble account, and a public port answers anyone.
  - Listing: boxes take no labels, so the listing could not tell Amika's
    boxes from the account's others.
  - Minted SSH access, auto-delete, and account sizes.

## Running the contract suite

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=orble \
TEST_SANDBOX_CONTRACT_SNAPSHOT=debian-13 \
ORBLE_API_KEY=orble_... \
pnpm --filter @amika/sandbox test:integration
```
