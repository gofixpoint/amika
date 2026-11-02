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
  `openAcmeAdapter`. A provider that builds on another's runtime primitives
  imports them through that provider's root entries, never its `internal/`:
  `smol/provider.ts` re-exports its client and operations for `amika-hostd/`,
  whose daemon serves a superset of smolvm's API.
- `config.ts` — the **top-level config slice** the caller constructs. Kept at
  the root (not in `internal/`, not routed through `provider.ts`) so the
  registry and the package barrels import the config type straight from it,
  independent of the SDK-bearing `provider.ts`. It is **SDK-free** — a plain
  interface extending `SandboxConfigBase` — so importing it pulls in no vendor
  SDK.
- `capabilities.ts` — SDK-free capability flags. These are re-exported from the package's `./client`
  entry (`src/client.ts`) and imported by browser code, so they must never reach
  a vendor SDK: routing them through `provider.ts` would pull the SDK into the
  browser bundle, and moving them into `internal/` would put them out of the
  client entry's reach.

The fully grown Daytona provider shows the split:

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

## The `simulate` provider

`simulate/` is a provider with no vendor behind it. Every sandbox is a record
in an in-memory `SimulateWorld`, and the provider backs the whole contract
(lifecycle, exec, files, ssh, services, listing, snapshots) over that record.
A control plane configured with `SIMULATE_ENABLED=true` can run its create,
start, stop, snapshot, and metering paths end to end with no cloud account.

The world is the control surface. A test (or a control API) calls
`getSimulateWorld(worldId)` with the same id the provider was built with and
then scripts the scenario: `onExec` sets command output, `failNext` /
`failAlways` make an operation throw, `setLatency` slows one down, `vanish`
drops a sandbox the way an outage would, and `freezeTime` / `advanceTime`
move the clock (which applies auto-stop and auto-delete). Ids and tokens come
from a counter, so a scenario replays the same way every run.

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
   - `src/config-from-env.ts` — add `acme: AcmeConfig | null` to
     `SandboxProviderConfigs` and read acme's env vars in
     `sandboxProviderConfigsFromEnv`, gated on `ACME_ENABLED`. This is the
     one env contract: the contract suite, the sweep, and the control plane
     all build acme's config through it
   - `contract/env-target.ts` — add acme to `ENABLE_VAR` (its enable flag),
     `CONFIG_KEY` (its slice in `SandboxProviderConfigs`), and
     `IDENTITY_FIELDS` (the config fields that decide which account and
     endpoint acme's resources live in). All three are exhaustive over the
     name union, so each is a compile error until done
   - `go/test/e2e/runner/runner.go` — add `"acme"` to
     `SupportedSandboxProviders` so the CLI e2e cases can select it

3. **Run the contract suite against acme** (see "Testing a provider" below)
   until it is green. This is the fast loop: no control plane, minutes per
   run. It builds acme from the env vars you just wired up.

4. **Deploy the control plane with acme enabled.** It reads the same env
   contract, so this is setting `ACME_ENABLED` and acme's credentials on the
   deployment, not new code.

5. **Run the CLI e2e cases against acme** on that deployment:
   `make test-e2e-api E2E_SANDBOX_PROVIDER=acme`.

The registry table is exhaustive over the name union, so forgetting a
registration fails to compile, and `defineProvider`'s capability
reconciliation fails construction if the flags oversell the implementation.
The two test layers below check everything the type system cannot.

## Testing a provider

There are two layers. Run them in this order.

| Layer             | Where                           | What it proves                                                         | Needs                                      |
| ----------------- | ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| Provider contract | `contract/` in this package     | The provider honors `SandboxProvider` against the real vendor          | Vendor credentials, a bootable snapshot    |
| CLI e2e (`api-*`) | `go/test/e2e/` at the repo root | The whole stack works: CLI, control plane, registry wiring, the vendor | A deployed control plane with the provider |

### The provider contract suite

`contract/contract.ts` is one set of behavior checks written once against the
`SandboxProvider` interface, with no mocks. Each scenario is a short, linear
script: create a sandbox, run `echo hello`, expect `hello\n`. Scenarios are
selected by the provider's capability flags, so a flag set to `true` is a
promise the suite checks and a flag set to `false` skips its scenarios. A
provider cannot pass by turning flags off: `lifecycle` and `exec` scenarios
are what the control plane needs, and the e2e layer fails without them.

Two entry points run the same suite:

- `contract.test.ts` runs it against `simulate` on every `pnpm test`. This
  keeps the suite itself correct and makes `simulate` the reference
  provider. `simulate` has no shell, so the suite's commands are scripted
  into its world through the `scriptExec` hook; a real vendor runs them.
- `contract.integration.test.ts` runs it against a real vendor:

  ```bash
  TEST_SANDBOX_CONTRACT_PROVIDER=e2b \
  TEST_SANDBOX_CONTRACT_SNAPSHOT=<snapshot or image the vendor can boot> \
  E2B_API_KEY=... \
  pnpm --filter @amika/sandbox test:integration
  ```

  Vendor credentials use the same env vars the control plane reads
  (`../config-from-env.ts`). The entry turns the provider's `*_ENABLED` flag
  on itself. Names carry a per-run id so two runs never collide. The suite
  is not run in CI against real vendors; run it by hand when adding or
  changing a provider.

#### What the fixture must provide

The suite assumes the sandbox booted from `TEST_SANDBOX_CONTRACT_SNAPSHOT`
has a POSIX shell with `echo`, `printf`, `pwd`, `sleep`, and `exit`; that
`/tmp` exists; that `$HOME` is the provider's `userHomeDir` and is writable;
and that service URLs are `http://` or `https://`. These are requirements on
the test fixture, stated at the top of `contract.ts`.

#### The audit ledger

Every resource the suite creates is written as one JSON line in
`.contract-runs/<run id>/audit.jsonl`, and after each test the suite deletes
what that test created, newest first, and appends the outcome:

- **Sandboxes** are recorded by their unique name before create. An
  `identified` line adds the provider id when create returns or cleanup
  recovers it from the listing. A lost create response stays auditable.
- **Snapshots** are recorded by name **before** capture, because a capture
  can create the snapshot and still throw. An `identified` line adds the
  bootable id once capture returns.
- **SSH access** is recorded the moment it is minted, so it is revoked even
  when an assertion about it fails. The token is a secret and is never
  written; the line names the sandbox instead.

The first line is a `run` header naming the provider and its target: the
config fields that decide where resources live and a 12-character SHA-256
prefix of each credential (`targetIdentity` in `env-target.ts`).

A delete is not trusted on its own. Sandboxes are verified against the
provider's listing; snapshots with `find`, which also sees one still
registering. A resource still present after the wait is recorded as
`delete_failed`, the same as a delete that threw. An opaque snapshot id can also be recovered by name on E2B and Freestyle.
If neither capture nor lookup yields an id on an opaque-id provider, cleanup
fails rather than reporting it gone. If writing an outcome fails,
the remaining resources are still deleted and the test fails.

When the run ends it prints one table: every resource, the test that
created it, and `deleted`, `deleted (unverified)`, or `LEAKED` with the
reason. **Any leak fails the run**, and so does a ledger that cannot be read
or a step summary that cannot be written: the teardown fails closed. On
GitHub Actions the table is also appended to the step summary with a
`::warning::` per leaked resource; upload `.contract-runs/` as an artifact
with `if: always()` to keep the raw ledger. `TEST_SANDBOX_CONTRACT_RUNS_DIR`
moves the run directory, for example onto a CI artifact path.

A run that is killed (SIGKILL, a CI timeout) leaves `created` lines with no
outcome. The next run warns about them. Delete them with:

```bash
pnpm --filter @amika/sandbox sweep:contract --dry-run   # list
pnpm --filter @amika/sandbox sweep:contract             # delete
```

The sweep needs the vendor credentials in env. It refuses a run whose
header is missing or whose target differs from the one it is configured
for: in another account a by-name lookup finds nothing, which would mark a
live resource deleted. It deletes through the provider, verifies the same
way the run does, and appends each outcome marked `swept`. It skips a run
whose process is still alive. SSH access cannot be swept, since its token is
never on disk: the sweep names the sandbox and exits non-zero, and a person
revokes it in the vendor console and then deletes that run's directory. The
sweep is never automatic: an old ledger looks the same as one from a run
still in progress.

Keep the scenarios readable. One scenario is one `it` with no shared state
beyond the sandbox it creates, and it asserts on outcomes a human can check
(`stdout` is `hello\n`), never on vendor response shapes.

#### GitHub Actions runs

The manual **Sandbox provider contract** workflow runs vendor tests or
reclaims vendor resources using ledgers saved by a finished Actions run.
It runs only on the repository's default branch. It does not run vendor
tests on pull requests.

Create a `sandbox-contract` GitHub environment. Under **Deployment branches
and tags**, restrict it to the default branch before adding secrets. A branch
can change the workflow guard, so the environment policy enforces this
restriction. Add required reviewers if your deployment policy needs them.
In its **Secrets** settings,
add the key for each provider you use: `DAYTONA_API_KEY`, `E2B_API_KEY`,
`FREESTYLE_API_KEY`, or `VERCEL_TOKEN`. In its **Variables** settings, add any
optional provider settings you need:

- Daytona: `DAYTONA_API_URL`, `DAYTONA_ORGANIZATION_ID`, `DAYTONA_TARGET`,
  `ENABLE_DAYTONA_VM`.
- Freestyle: `FREESTYLE_API_URL`, `FREESTYLE_STAGING_SNAPSHOTS`.
- Vercel: `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`.

Use the same credentials and settings for tests and cleanup. The sweep
compares them with the ledger's recorded target and credential hashes.

In GitHub, open **Actions → Sandbox provider contract → Run workflow**.
Select the default branch, set `operation` to `test`, choose `provider`,
and enter its boot snapshot in `snapshot`. That input supplies
`TEST_SANDBOX_CONTRACT_SNAPSHOT`. For example, with `gh` authenticated:

```bash
gh workflow run sandbox-contract.yml --repo gofixpoint/amika \
  -f operation=test -f provider=daytona -f snapshot=YOUR_BOOT_SNAPSHOT
```

The examples use `gofixpoint/amika`; replace it if running in another repo.
The workflow saves `sandbox-contract-ledgers-<attempt>` for 30 days. An
attempt is a re-run of the same Actions run; the first attempt is `1`.
Both test and sweep runs upload an artifact with this naming scheme,
including hidden files and any cleanup results appended to the ledgers.
The upload step uses `if: always()`, so an ordinary test failure still
uploads its ledgers.

To reclaim resources, open **Run workflow**, set `operation` to `sweep`,
and enter `source_run_id`. Find that number in the source run's URL:
`https://github.com/OWNER/REPO/actions/runs/123456789` has id `123456789`.
Keep `dry_run` enabled to list resources without deleting them. Run again
with it disabled to delete them. The `provider` and `snapshot` inputs are
ignored for a sweep. You can also start a dry run with:

```bash
gh workflow run sandbox-contract.yml --repo gofixpoint/amika \
  -f operation=sweep -f source_run_id=123456789 -F dry_run=true
```

The source is normally a test or sweep run of this workflow. The command
also accepts ledgers uploaded by another trusted workflow, provided its run
finished on the default branch after a push, schedule, or manual dispatch.
Pull request and fork runs are refused. GitHub's finished status replaces
the local process check: the old process id belongs to another runner.
The account and credential checks still apply before any vendor deletion.

By default the sweep downloads the source run's latest attempt artifact.
Set `artifact_name` to `sandbox-contract-ledgers-1`, for example, to select
the first attempt after the source run has been re-run.

To download and sweep from a laptop, install `gh` and authenticate with
`gh auth login`. The account or token needs read access to that repository's
Actions artifacts (`actions:read` for a fine-grained token). Set the matching
vendor credentials and settings, then run:

```bash
pnpm --filter @amika/sandbox sweep:contract:actions \
  --repo gofixpoint/amika --run-id 123456789 \
  --directory /tmp/contract-ledgers-123456789 --dry-run
```

Use a new or empty directory for each download. Omit `--dry-run` to delete.
`--artifact-name` selects a different saved artifact. A missing, expired,
empty, or malformed artifact fails the command; it never means cleanup
succeeded. The downloaded files stay on disk with each cleanup result
appended to its ledger.

For another workflow cleanup attempt, use the most recent **sweep run's** id
as `source_run_id`. Its artifact contains the updated ledgers, so successful
deletes are not replayed from the original, unchanged test artifact. The
latest-attempt rule applies to sweep runs too. For a local retry, keep the
downloaded directory and run the local `sweep:contract` command with
`TEST_SANDBOX_CONTRACT_RUNS_DIR` set to that directory.

Uploads are best effort. A job timeout, cancellation, or runner failure can
stop the runner before it uploads anything, even with `if: always()`. This
cannot recover ledgers that were never uploaded or have expired. SSH access
still needs manual revocation in the vendor console because its token is
never stored in a ledger. The workflow does not run cleanup automatically.

### Per-provider unit tests

A provider folder keeps unit tests only for logic the contract cannot see
from the outside: command building, state mapping, retry policy, pagination,
snapshot name aliasing. Tests that mock the vendor SDK to re-check contract
behavior (create then stop then start) belong in the contract suite instead.
