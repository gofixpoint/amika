# Local macOS VMs with Lume

The `lume` provider runs macOS rigs on an Apple Silicon Mac with
[Lume](https://github.com/trycua/cua/tree/main/libs/lume). It is not on in
the hosted app or the CLI yet.

## How it works

- `snapshot` names a stopped **template** VM in Lume's default storage. A
  template from `lume create --ipsw <file> --unattended tahoe` works: it has
  the bootstrap user `lume` / `lume`, and Remote Login is on.
- Each rig is an APFS clone of the template in `storageDir`, apart from
  other Lume VMs on the Mac. A clone takes about 2 s and no new disk.
- The provider uses the `lume` CLI, and boots each VM in its own process
  (`lume run --detach`).
- On create, the **SSH bootstrap** logs in one time with the bootstrap
  password. It adds the `amika` user, installs a key for this VM only,
  gives `amika` `sudo` with no password, and then turns password login off.
  It checks each step before the next one.
- Commands and files go over the system `ssh` client with that key. The key,
  the VM's known hosts, and its Lume log are in `stateDir/vms/<name>/`.
- Apple's Virtualization.framework runs at most two macOS VMs at a time. A
  third boot fails, and the error comes from the VM's Lume log.

Not supported yet: services, SSH access for users, snapshots, `envVars`,
auto-stop, and a disk size different from the template's.

## Testing

Unit tests run with `pnpm test`. On a Mac with Lume and a template, run the
provider contract, then the Lume-only checks:

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=lume \
TEST_SANDBOX_CONTRACT_SNAPSHOT=<template> \
LUME_STORAGE_DIR=<folder> LUME_STATE_DIR=<folder> \
pnpm --filter @amika/sandbox test:integration src/providers/contract

TEST_LUME_TEMPLATE=<template> \
LUME_STORAGE_DIR=<folder> LUME_STATE_DIR=<folder> \
pnpm --filter @amika/sandbox test:integration src/providers/lume
```

Both run one VM at a time. Each contract scenario takes about 17 s.
