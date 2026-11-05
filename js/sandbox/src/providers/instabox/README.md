# Instabox provider

[Instabox](https://instabox.sh/docs) runs Linux VMs ("machines") with their
own kernel, root, and Docker. This provider drives them through the Instabox
REST API (`https://api.instabox.sh/v1`) with the small client in
`internal/client.ts`. It does not use the `@insforge/instabox-sdk` package.

## Configuration

| Variable           | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `INSTABOX_ENABLED` | `true` turns the provider on                      |
| `INSTABOX_API_KEY` | An `ibk_…` API key                                |
| `INSTABOX_API_URL` | Optional API base URL (`https://api.instabox.sh`) |

## What a sandbox boots from

`CreateSandboxProviderInput.snapshot` is one of:

- a snapshot id (`sn_…`), such as one this provider captured;
- the name of a snapshot in the account, such as a Docker image imported with
  `instabox snapshot import <image> --name <name>`;
- a template id (`agent-browser`, `ci`, …), optionally pinned as
  `agent-browser@<version>`. `GET /v1/templates` lists them.

## How the contract maps to Instabox

- **User and home.** Commands run as `user` (UID 1000) with
  `bash -lc`. Home is `/data/home`, on the persistent disk. `sudo` needs no
  password.
- **Stop and start.** `stop` is an Instabox stop: programs end, files stay,
  and the next start boots fresh. Instabox also pauses ("suspends") a machine
  after an idle period, and commands, files, and SSH wake it. Instabox cannot
  stop a paused machine, so `stop` resumes it first. `autoStopInterval`
  (minutes) sets the idle pause, clamped to 5–30 minutes; `0` turns it off.
- **Exec.** Always over the SSE stream, so output has no size cap. A command
  runs at most 10 minutes (exit code 124 after that). Run longer jobs in the
  background with their output in a file.
- **Env vars.** Instabox has no env field on create, so create ignores
  `envVars` (as Freestyle does). Provisioning writes them to
  `/etc/environment`.
- **Names.** Instabox names are 1–63 of `a-z`, `0-9`, `-`. Other names map to
  a slug plus a hash (`internal/names.ts`). The exact sandbox name is kept in
  the `amika-sandbox-name` machine label, which the listing reports.
- **Services.** Each service port is published as a **private** port, so the
  URL answers only with its `ibp_…` token. Instabox shows a token only once,
  so every URL refresh makes a new token, which ends the old one's sessions.
  Ports must be 1024 or higher. Route reconcile touches only ports whose name
  starts with `amika:`.
- **SSH.** The gateway listens on port 2222, so `sshDestination` is an
  `ssh://ibssh_…@ssh.instabox.sh:2222` URI. The returned `token` is the
  token's `cn_…` id, which revoke needs.
- **Snapshots.** A snapshot holds the disks only (no memory), and a running
  machine keeps running during capture. Ids are opaque (`sn_…`); a by-name
  lookup scans the snapshot list.
- **Auto-delete** is not supported: Instabox deletes only at a fixed time
  after create, not after an idle period.

## Running the contract suite

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=instabox \
TEST_SANDBOX_CONTRACT_SNAPSHOT=agent-browser \
INSTABOX_API_KEY=ibk_... \
pnpm --filter @amika/sandbox test:integration
```

The free plan allows 5 machines and 5 snapshots at a time. The suite stays
under that because each test deletes what it created.
