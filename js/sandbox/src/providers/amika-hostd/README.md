# Amika host daemon provider

The `amika-hostd` provider lets Node.js callers of `@amika/sandbox` manage
Smol virtual machines through an Amika host daemon. It supports creating a
machine from a container image, executing commands, transferring files,
listing machines, and stopping, starting, or deleting them.

First follow the [host daemon setup](../../../../amika-hostd/AGENTS.md#development) on the
VM host. Both `smolvm serve` and `amika-hostd` must be running; the provider
connects to hostd, which contacts the local runtime. The provider does not
start either process. Authentication is not implemented yet.

In a workspace application that depends on `@amika/sandbox`, construct the
provider through the registry:

```ts
import {
  createSandboxProvider,
  moduleLogger,
  type SandboxCtx,
} from "@amika/sandbox";

const provider = createSandboxProvider("amika-hostd", {
  daytona: { apiKey: "" }, // Registry requires this slice; hostd does not use it.
  e2b: null,
  freestyle: null,
  vercel: null,
  smol: null,
  amikaHostd: { apiUrl: "http://127.0.0.1:3020", network: true },
  resolveSnapshotId: async () => null,
});
const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };

const sandbox = await provider.sandboxes.create(ctx, {
  name: "host-demo",
  snapshot: "ubuntu:24.04", // Container image reference, not a saved snapshot.
  services: [],
  resources: { vcpus: 2, memoryGib: 2, diskGib: 20 },
});
try {
  await sandbox.writeFile("/workspace/hello.txt", "hello\n");
  console.log(await sandbox.exec("cat /workspace/hello.txt"));
  await sandbox.stop();
  console.log(await sandbox.getState()); // Reads state without starting it.
  await sandbox.start();
} finally {
  await sandbox.delete();
}
```

Create waits for start to succeed. If start fails, the provider deletes the
newly created machine; a name conflict never triggers deletion. Commands run
as root through `/bin/sh -c`; images must contain that shell. Exec supports
`cwd`, `env`, and string `input`. File reads return UTF-8 text or `null` for a
missing file, and writes accept strings or buffers.

`AmikaHostdConfig` is exported from the package root. `apiUrl` defaults to
`http://127.0.0.1:3020`, `network` defaults to false, and `requestTimeoutMs`
defaults to 310000 so hostd can report its default 300000 ms runtime deadline.
If you increase the daemon deadline, increase the provider deadline too.
A deadline does not terminate a guest command. Enable networking for remote
image pulls and outbound guest traffic.

For callers using `sandboxProviderConfigsFromEnv`, set
`AMIKA_HOSTD_ENABLED=true`, optionally `AMIKA_HOSTD_API_URL` and
`AMIKA_HOSTD_NETWORK=true`. The helper returns an `amikaHostd` config slice
and still requires `DAYTONA_API_KEY`. Direct configuration above needs no
cloud credentials. Existing registry callers must add `amikaHostd: null`
when this provider is disabled.

SSH, service routing, streamed output, snapshots, and automatic timers are
not supported. Pass `services: []` and omit timers or set them to zero.
The `lifecycle` capability is false because full provisioning requires
service routing; direct `start`, `stop`, and state calls still work.

Stop preserves disk but ends running processes. Exec and file access inherit
Smol's ability to start a stopped machine. Listings include all machines in
the runtime, including those created outside Amika; labels are not persisted
and `orgId` is null. Machines without reported storage sizing are omitted
from the sandbox listing. `diskGib` sizes the `/workspace` storage disk.
Hostd limits request bodies to 64 MiB.

This change only adds the package provider; enabling it in the hosted Amika
app or CLI is a separate integration.
