# Sandbox providers

A **provider** plugs a sandbox vendor's SDK into the package's provider
contract (`provider.ts`). Everything provider-agnostic — the resource-object
synthesis, the adapter port, the shared scrub orchestration — lives in
`shared/`; a provider folder contains only vendor-specific code. (Repo cloning
is provisioning orchestration, not a provider concern, so it lives in
`@amika/sandbox-provisioning`.)

## Layout

| Path              | Role                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `provider.ts`     | The contract: capability interfaces, input/result types, error classes                                  |
| `registry.ts`     | Name → provider table (`PROVIDERS`); `createSandboxProvider` / `getSandboxAdapter`                      |
| `capabilities.ts` | Client-safe aggregation of every provider's capability flags + display info                             |
| `shared/`         | Provider-agnostic framework: `define-provider`, `resources`, the `SandboxAdapter` port, `scrub-exec`, … |
| `daytona/` etc.   | One folder per provider                                                                                 |

### Provider folder layout

A provider folder root holds its **public entries**; everything that touches
the vendor SDK lives in `internal/`, which the `local/no-cross-package-internal`
lint rule makes unreachable from outside the folder. There are three public
entries:

- `provider.ts` — the SDK-bearing definition. The registry imports the provider
  factory from here, plus (when the provider has one) the re-exported
  `openAcmeAdapter`.
- `config.ts` — the **top-level config slice** the caller constructs. Kept at
  the root (not in `internal/`, not routed through `provider.ts`) so the
  registry and the package barrels import the config type straight from it,
  independent of the SDK-bearing `provider.ts`. It is **SDK-free** — a plain
  interface extending `SandboxConfigBase` — so importing it pulls in no vendor
  SDK.
- `capabilities.ts` — SDK-free capability flags, plus `sizing.ts` / `naming.ts`
  when a provider has them. These are re-exported from the package's `./client`
  entry (`src/client.ts`) and imported by browser code, so they must never reach
  a vendor SDK: routing them through `provider.ts` would pull the SDK into the
  browser bundle, and moving them into `internal/` would put them out of the
  client entry's reach.

The fully grown Daytona provider shows the split; other providers additionally
keep `sizing.ts` (Vercel, Freestyle) and `naming.ts` (Freestyle) at the root:

```
daytona/
  provider.ts        # public entry: definition + adapter re-exports
  config.ts          # SDK-free config slice (read by registry + barrels)
  capabilities.ts    # SDK-free capability flags (read by ./client)
  internal/          # unreachable from outside daytona/ (lint-enforced)
    operations.ts  adapter.ts  client.ts  commands.ts
    configure.ts  docker-registry.ts  snapshot-operations.ts
    types.ts  vm.ts
    *.test.ts        # tests colocate with the module they cover
```

## Adding a provider ("acme")

1. **Create `acme/`** with:
   - `config.ts` — the config slice the caller constructs, at the folder root
     (a top-level public entry: the registry and the package barrels import the
     config type straight from it, so it must not live in `internal/`). It stays
     SDK-free — a plain interface — so importing it pulls in no acme SDK:

     ```ts
     import type { SandboxConfigBase } from "../../config";

     export interface AcmeConfig extends SandboxConfigBase {
       apiKey: string;
     }
     ```

   - `capabilities.ts` — SDK-free capability flags, at the folder root (kept
     separate so client bundles can read them without importing the acme SDK):

     ```ts
     import type { SandboxProviderCapabilities } from "../provider";

     export const acmeCapabilities: SandboxProviderCapabilities = {
       lifecycle: true,
       ssh: false,
       services: false,
       exec: true,
       listSandboxes: false,
       streaming: false,
       snapshots: false,
       fullSnapshotCapture: false,
       scrubCapture: false,
       dockerRegistries: false,
       skipStartScript: false,
       snapshotIdsAreOpaque: false,
       supportsAutoDelete: false,
     };
     ```

   - `provider.ts` — the definition, at the folder root. Import the SDK, plug
     its calls into the capability namespaces, and omit what acme doesn't
     support. The config type is imported from the sibling `config.ts`; the
     registry imports it from there too, so `provider.ts` re-exports only
     `openAcmeAdapter` (if the provider has one):

     ```ts
     import { Acme } from "acme-sdk";
     import type { AcmeConfig } from "./config";
     import { defineProvider } from "../shared/define-provider";
     import { acmeCapabilities } from "./capabilities";

     export default defineProvider(acmeCapabilities, (config: AcmeConfig) => {
       const acme = new Acme({ apiKey: config.apiKey });
       return {
         name: "acme",
         signedUrlTtlSeconds: 3600,
         userHomeDir: "/home/amika", // per-provider constant, surfaced as provider.userHomeDir
         sandbox: {
           create: async (ctx, input) => ({
             provider: "acme",
             providerSandboxId: (await acme.create(input.name)).id,
             providerUrl: null,
             services: input.services,
           }),
           delete: (id) => acme.delete(id),
           // Run-state control (start/stop/getState/mapState): omit the whole
           // group → create/delete-only, capabilities.lifecycle false.
           start: (id) => acme.start(id),
           stop: (id) => acme.stop(id),
           getState: async (id) => (await acme.get(id)).state,
           mapState: (raw) => (raw === "running" ? "running" : "unknown"),
         },
         exec: { run: (id, command, opts) => acme.exec(id, command, opts) },
         // omit ssh / services / listing / snapshots / dockerRegistries →
         // they resolve as unsupported and the flags above must say false.
       };
     });
     ```

     `defineProvider` fills the rest: omitted namespaces become `null`,
     `exec.streaming` derives from whether `stream` is present, snapshot
     defaults cover `createImageSnapshot`/`findSnapshot`/`removeInjectedSecrets`,
     and the flags are checked against the definition at construction — a flag
     that disagrees with the implementation throws immediately.

     Keep trivial calls inline like above; grow an `internal/operations.ts` when
     real logic accumulates (see `daytona/` for the fully grown shape).

   - If the provisioning lifecycle should run on acme sandboxes (`lifecycle:
true`), implement the `SandboxAdapter` port (`shared/adapter.ts`: exec,
     file read/write, home dir) in `internal/adapter.ts`, expose it as
     `openAcmeAdapter`, and re-export that from `provider.ts` too, so the
     registry's `openAdapter` can reach it. You do **not** implement cloning:
     the provisioning layer clones over the adapter's exec port. Only add a
     `cloneRepo` override (surfaced as the optional `Sandbox.git`) if acme's SDK
     has a first-class clone primitive worth preferring over shell `git`.

2. **Register it** (each is one small edit; the type system walks you through):
   - `src/types.ts` — add `"acme"` to the `SandboxProviderName` union
   - `registry.ts` — add `acme: AcmeConfig | null` to the
     `SandboxProviderDeps` interface (import `AcmeConfig` from `./acme/config`),
     and the `acme` entry to `PROVIDERS` with `create` + `openAdapter` (import
     `openAcmeAdapter` from `./acme/provider`)
   - `capabilities.ts` — add `acmeCapabilities` to `SANDBOX_PROVIDER_CAPABILITIES`
     and a label to `SANDBOX_PROVIDER_DISPLAY`
   - `src/index.ts` — re-export the config type
     (`export type { AcmeConfig } from "./providers/acme/config";`) so consumers
     get it from the package barrel

3. **Wire the config through the caller** — the control plane constructs
   `SandboxProviderDeps`, so its env builder needs to supply `deps.acme`.

That's it: the registry table is exhaustive over the name union, so forgetting
a registration fails to compile, and `defineProvider`'s capability
reconciliation fails construction if the flags oversell the implementation.
