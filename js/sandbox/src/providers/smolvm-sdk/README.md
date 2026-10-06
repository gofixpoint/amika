# Embedded smol machines

The `smolvm-sdk` provider runs local Linux VMs from OCI images inside the
calling Node.js process, through the
[`smolmachines`](https://www.npmjs.com/package/smolmachines) SDK: smolvm's
engine, embedded, with no `smolvm` binary or `smolvm serve` process beside it.
Use it where the `smol` provider would otherwise need a separately managed
`smolvm serve`. amika-hostd runs its machines on it.

The SDK ships the engine for Linux x64/arm64 (glibc 2.34+) and macOS on Apple
silicon, as per-platform optional dependencies of `smolmachines`; on Linux the
process needs access to `/dev/kvm`. Importing the provider is cheap anywhere:
the engine loads only on the first machine call.

```ts
import { createSandboxProvider, type SandboxCtx } from "@amika/sandbox";

const provider = createSandboxProvider("smolvm-sdk", {
  ...otherSlices,
  smolvmSdk: { network: true },
});
const sandbox = await provider.sandboxes.create(ctx, {
  name: "local-demo",
  snapshot: "ubuntu:24.04", // OCI image reference
  resources: { vcpus: 2, memoryGib: 2, diskGib: 20 },
  services: [],
});
```

For callers using `sandboxProviderConfigsFromEnv`, set
`SMOLVM_SDK_ENABLED=true` and optionally `SMOLVM_SDK_NETWORK=true`.

## How it maps onto the SDK

Every operation is a call on the SDK's public `Machine` API, made with
`{ target: "local", handleSignals: false }` (the embedding process owns
shutdown): create, delete, start and stop, state and listing, exec, and file
transfer. Where the API has no call for something, other public calls fill
the gap:

- The engine's machine database is shared with the `smol` CLI and every other
  embedder on the host, so the provider labels its machines and sees only
  labeled ones. `Machine.list` reports no sizes or ports, so those are stored
  in labels too, with the caller's labels (the org id is read back from them).
- Each service's guest port is published on a host loopback port the provider
  picks; its URL is `http://127.0.0.1:<host port>`. Ports are published only
  at create and cannot be unpublished, so `syncRoutes` succeeds only when the
  desired services' ports are exactly the published ones: it refuses a new
  port, and it refuses to revoke the last service on a port, whose forward
  would keep accepting connections.
- Commands run as root under `/bin/sh -c`; the home directory is `/root`.
  Exec takes no stdin, so `input` is staged in a root-only guest temp file and
  redirected in.
- A machine paused through the `smol` CLI or the SDK reports `suspended`.
  Start, exec and file access resume it (a paused machine refuses a fresh
  boot), and stop leaves it alone, since its VM is already stopped.
- A machine's `state()` blocks the event loop while a file transfer holds the
  machine's lock, so the provider never calls it and reads state from
  `Machine.list`.
- Machines are persistent (disks outlive stop and process restarts) but not
  detached: the engine reaps them when the process exits. `stopAll` (from
  `smolvmSdkOperations`) stops them cleanly first.

Handles on machines are cached per SDK object, so providers built repeatedly
in one process share them.

## Limitations

These come from the public API, which the provider does not work around:

- **Published ports must listen.** `Machine.create`, `Machine.connect` and a
  machine's `start` wait up to 120s for every published port to accept
  connections, then fail with `TIMEOUT`; `create` also deletes the new
  machine. A sandbox whose services are not all listening within two minutes
  of boot cannot be created, and cannot be reconnected to after a restart.
- **Create boots.** There is no create-without-boot.
- **Connect boots, on the event loop.** The only handle on a machine an
  earlier process left behind comes from `Machine.connect`, which boots a
  stopped machine synchronously. Deleting such a machine boots it first.
- **A paused machine needs a held handle.** `Machine.connect` refuses a
  machine with saved execution, so one paused while this process holds no
  handle on it cannot be resumed, stopped or deleted here (`CONFLICT`).
- **No ordering beyond the engine's.** The engine serializes lifecycle calls
  on one machine, but a stop or delete can land while an exec or file
  transfer on that machine is running, and cut it off.
- Published forwards are TCP only: UDP services are refused at create and when
  reconciling routes.
- No streaming exec, SSH, snapshots or auto-stop/delete timers. File reads are
  UTF-8 text, as the provider contract defines them.
