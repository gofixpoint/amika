# boxd provider

[boxd](https://boxd.sh) runs Ubuntu microVMs ("machines"). Its API is gRPC
only (`boxd.api.v1.BoxdApi` at `boxd.sh:9443`), so this provider uses boxd's
SDK (`@boxd-sh/sdk`, pinned) instead of a fetch client. The SDK, and the
`@grpc/grpc-js` it needs, load only when a boxd provider makes its first
call.

## Configuration

| Variable       | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `BOXD_ENABLED` | `true` turns the provider on                               |
| `BOXD_API_KEY` | A `bxd_…` API key                                          |
| `BOXD_API_URL` | Optional gRPC endpoint (`https://boxd.sh:9443`, Frankfurt) |

## What a machine boots from

`CreateSandboxProviderInput.snapshot` is `ubuntu:24.04` (boxd's default
image) or another image ref boxd accepts.

## How the contract maps to boxd

- **User and home.** boxd logs in as `boxd`. Create makes the `amika` rig
  user (home `/home/amika`, passwordless `sudo`) before it returns.
  Commands run as `amika` through `sudo`, and files go through a staging
  file under `/home/boxd` (`../shared/rig-user.ts`).
- **Isolation.** Create sets `isolated`: the machine gets none of the boxd
  org's peers, in-VM boxd CLI, credentials, or integrations.
- **Size.** boxd has four classes, each with a 100 GB disk: 1 vCPU and
  4 GiB, 2/8, 4/16, and 8/32. Any other size is refused.
  `provider.account.sizes()` returns the classes under the org's quota
  (`GetOrgMachineDefaults`).
- **Stop and start.** `stop` powers the machine off (disk kept). boxd also
  suspends an idle machine with its memory kept; `autoStopInterval` sets
  that timeout, `0` turns it off, and a command wakes the machine. boxd
  cannot stop a sleeping machine, so `stop` wakes it first.
- **Exec.** boxd's `Exec` stream, with stdout and stderr apart. boxd has no
  time limit; the provider stops a command after 30 minutes.
- **Not supported:**
  - Snapshots: a boxd snapshot always keeps memory and running programs,
    which a scrub before capture cannot clean.
  - Service URLs: boxd's HTTPS URLs answer anyone, with no token.
  - Minted SSH access: an API key cannot link an SSH key.
  - Auto-delete.

## Running the contract suite

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=boxd \
TEST_SANDBOX_CONTRACT_SNAPSHOT=ubuntu:24.04 \
BOXD_API_KEY=bxd_... \
pnpm --filter @amika/sandbox test:integration
```
