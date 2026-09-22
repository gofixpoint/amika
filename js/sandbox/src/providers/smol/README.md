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
    snapshot: "ubuntu:24.04", // OCI image reference, not an Amika snapshot name.
    resources: { vcpus: 2, memoryGib: 2, diskGib: 20 },
    services: [],
  });
  try {
    await sandbox.writeFile("/workspace/hello.txt", "hello\n");
    console.log(await sandbox.exec("cat /workspace/hello.txt"));
    await sandbox.stop(); // Preserves disk, not running processes.
    console.log(await sandbox.getState()); // Does not restart the VM.
    await sandbox.start();
  } finally {
    await sandbox.delete();
  }
}

await example(ctx);
```

Commands execute as root using `/bin/sh -c`; images must provide that shell.
The reported home directory is `/root`. `cwd`, `env`, and `input` are supported
on exec; `sudo` is redundant because execution already uses root. File uploads
create parent directories. The runtime can auto-start stopped machines on exec
or file access, but status checks and listings are read-only.

`network` defaults to false. Enable it when using images from a remote registry or workloads needing
outbound access. `requestTimeoutMs`
defaults to 300000 and bounds the HTTP request, not the lifetime of a guest
process after the client disconnects. Stop or delete the VM to terminate work.

For callers using `sandboxProviderConfigsFromEnv`, set `SMOL_ENABLED=true`,
optionally `SMOL_API_URL` (default `http://127.0.0.1:8080`) and `SMOL_NETWORK=true`.
That shared helper still requires `DAYTONA_API_KEY`; direct configuration as
above does not need real cloud credentials.

Service routing, SSH access, streamed output, snapshots, and automatic
stop/delete timers are not implemented. Pass an empty service list and omit
timers (or set them to zero). The full provisioning `lifecycle` capability is
false because it includes service routing. Consumers that require that flag
should exclude Smol from their provisioning flows; direct `start`, `stop`, and
state operations remain available. Nonempty service requests or nonzero timers fail
before a VM is created.

Listings cover the runtime's machines, including machines created outside
Amika. Smol has no provider label support: `labels` are not persisted and
`orgId` is null. Records without reported disk sizing are omitted, so listing is not an
exhaustive inventory on older runtimes. Disk sizing maps to Smol's storage disk
(which backs `/workspace`); changes elsewhere in the image use a separate
writable overlay whose size remains at the runtime default.

The wire contract is the local `/api/v1/machines` API, not the smol cloud API.
See [the local API reference](https://smolmachines.com/docs/local/local-api-smolvm-serve)
and use `smolvm serve openapi` to inspect your installed runtime's contract.
