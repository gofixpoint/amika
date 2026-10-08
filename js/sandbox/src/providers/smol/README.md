# Local smol machines

The `smol` provider lets Node.js callers of `@amika/sandbox` create local
Linux VMs from OCI images, execute commands, transfer files, stop/start VMs,
and delete them through the same sandbox resource API as the cloud providers.
It talks to a separately managed [smolvm](https://smolmachines.com/) HTTP server.
This change adds the package provider; it does not enable Smol in the hosted
Amika app or CLI.

Install smolvm using its [local setup instructions](https://smolmachines.com/docs/local/quick-start),
on a host with hardware virtualization available. On Linux, the runtime user
needs access to `/dev/kvm`. Start the server on that host:

```sh
smolvm serve start --listen 127.0.0.1:8080
```

The server has no authentication. Keep it on loopback; the Node.js caller must
be able to reach that address. An app running in a different container has its
own loopback interface.

This is a private source package in the Amika pnpm workspace, not a standalone
npm installation. Run `pnpm install` at the repository root. In an application
that already depends on `@amika/sandbox`, construct it through the registry (the
factory that selects a provider by name):

```ts
import {
  createSandboxProvider,
  moduleLogger,
  type SandboxCtx,
} from "@amika/sandbox";

const provider = createSandboxProvider("smol", {
  daytona: { apiKey: "" }, // Required registry slice; unused by Smol.
  e2b: null,
  freestyle: null,
  vercel: null,
  amikaHostd: null,
  smol: { apiUrl: "http://127.0.0.1:8080", network: true },
  resolveSnapshotId: async () => null, // Unused: Smol takes an image directly.
});

// Minimal logging context; an application can supply its own structured logger.
const ctx: SandboxCtx = {
  logger: moduleLogger(),
  childCtx: () => ctx,
};
async function example(ctx: SandboxCtx) {
  const sandbox = await provider.sandboxes.create(ctx, {
    name: "local-demo",
    // OCI image reference, not an Amika snapshot name. The image needs an
    // `amika` user (see below), as Amika's preset images from `sandbox-image/`
    // have.
    snapshot: "amika-coder:latest",
    resources: { vcpus: 2, memoryGib: 2, diskGib: 20 },
    services: [],
  });
  try {
    await sandbox.writeFile("/home/amika/hello.txt", "hello\n");
    console.log(await sandbox.exec("cat /home/amika/hello.txt"));
    await sandbox.stop(); // Preserves disk, not running processes.
    console.log(await sandbox.getState()); // Does not restart the VM.
    await sandbox.start();
  } finally {
    await sandbox.delete();
  }
}

await example(ctx);
```

Commands execute as the `amika` user with `HOME=/home/amika`, through
`/bin/sh -c`, the same contract as the cloud providers; `sudo: true` runs a
command as root with `HOME=/root` instead. Images must provide that shell and
an `amika` user whose home is `/home/amika`, which is also the reported home
directory. `cwd`, `env`, and `input` are supported on exec, and an `env` that
sets `HOME` overrides the default. File uploads create parent directories and
leave the file owned by `amika`: smolvm writes it as root, so the provider
`chown -h`s it afterwards, and an upload fails if that does not succeed. The runtime can auto-start stopped machines on exec
or file access, but status checks and listings are read-only.

`network` defaults to false. Enable it when using images from a remote registry or workloads needing
outbound access. `requestTimeoutMs`
defaults to 300000 and bounds the HTTP request, not the lifetime of a guest
process after the client disconnects. Stop or delete the VM to terminate work.

For callers using `sandboxProviderConfigsFromEnv`, set `SMOL_ENABLED=true`,
optionally `SMOL_API_URL` (default `http://127.0.0.1:8080`) and `SMOL_NETWORK=true`.
That shared helper still requires `DAYTONA_API_KEY`; direct configuration as
above does not need real cloud credentials.

Services are TCP ports published at create: the provider picks a free host
loopback port for each service's guest port and passes the mapping to smolvm,
and the service's URL is `http://127.0.0.1:<host port>` (so it is reachable
only from the smolvm host). smolvm cannot publish or unpublish a port later,
so `syncRoutes` succeeds only when the desired services' ports are exactly the
published ones, and UDP services are refused. (The `amika-hostd` provider
reuses these operations but leaves publishing to hostd, which routes services
by name; see `js/amika-hostd/AGENTS.md`.)

SSH access, streamed output, snapshots, and automatic stop/delete timers are
not implemented; omit timers (or set them to zero). Nonzero timers fail before
a VM is created.

Listings cover the runtime's machines, including machines created outside
Amika. Smol has no provider label support: `labels` are not persisted and
`orgId` is null. Records without reported disk sizing are omitted, so listing is not an
exhaustive inventory on older runtimes. Disk sizing maps to Smol's storage disk
(which backs `/workspace`); changes elsewhere in the image use a separate
writable overlay whose size remains at the runtime default.

The wire contract is the local `/api/v1/machines` API, not the smol cloud API.
See [the local API reference](https://smolmachines.com/docs/local/local-api-smolvm-serve)
and use `smolvm serve openapi` to inspect your installed runtime's contract.
