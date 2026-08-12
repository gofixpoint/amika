/**
 * `defineProvider` — the functional way to define a sandbox provider.
 *
 * A provider is a `(config) => SandboxProvider` factory. Rather than write a
 * class that implements every method of {@link SandboxProvider} (and hand-stub
 * the ops it doesn't support), a provider declares its capability namespaces
 * directly — the same shape the contract exposes — and omits the ones it can't
 * back:
 *
 *   export default defineProvider(fooCapabilities, (config: FooConfig) => ({
 *     name: "foo",
 *     signedUrlTtlSeconds: FOO_URL_TTL_S,
 *     sandbox: {
 *       create,
 *       delete,                 // create/delete always required
 *       start, stop, getState,  // run-state control; omit → lifecycle false
 *     },
 *     exec: { run },            // omit → capabilities.exec false
 *     // ...only the namespaces foo backs
 *   }));
 *
 * The built provider exposes only the resource-object surface —
 * `sandboxes`/`snapshots`/`docker` — synthesized over the declared namespaces;
 * the flat capability members are not on the public contract.
 *
 * The definition mirrors the output, so `defineProvider` is almost a pass-through.
 * It fills only the gaps the contract requires but the author can omit:
 *   - `sandbox.mapState` → the safe `() => "unknown"` default (no lifecycle ⇒ no
 *     raw state worth mapping)
 *   - `exec.streaming` → derived from whether `exec.stream` is present
 *   - `cloneRepo`      → `null` when omitted, so `Sandbox.git` is `null` and the
 *     provisioning layer clones over the adapter exec port instead
 *   - `snapshots.createImageSnapshot` / `findSnapshot` /
 *     `removeInjectedSecrets` → see {@link SnapshotDefinition}
 *   - every omitted namespace → `null`
 *
 * Two invariants are structural in the types below rather than enforced at
 * runtime: a `files`/`services` namespace requires *both* its methods, and
 * `stream` lives *inside* `exec` (so it can't exist without it). The
 * `sandbox` run-state ops (start/stop/getState) are a unit too, but since they
 * sit flat on `sandbox` the types can't enforce it, so {@link
 * assertCapabilitiesMatch} checks that at runtime alongside reconciling the
 * SDK-free `capabilities` flags against what the definition actually backs.
 */
import type {
  CloneRepoInput,
  DockerRegistryCapability,
  ExecCapability,
  FileCapability,
  ListingCapability,
  SandboxCapability,
  SandboxProvider,
  SandboxProviderCapabilities,
  ServiceCapability,
  ServiceRestartContext,
  SnapshotCapability,
  SshCapability,
} from "../provider";
import { SandboxProviderUnsupportedError } from "../provider";
import {
  makeDockerNamespace,
  makeSandboxNamespace,
  makeSnapshotNamespace,
  type ResourceBackend,
} from "./resources";

/**
 * `exec` as authored: `run` plus an optional `stream`. The `streaming` flag on
 * the built {@link ExecCapability} is derived from whether `stream` is present,
 * so the author never writes it (and can't let the two disagree). Keeping
 * `stream` a field of this object is what makes "streaming requires exec"
 * structural rather than a runtime assertion.
 */
type ExecDefinition = Omit<ExecCapability, "streaming" | "stream"> &
  Partial<Pick<ExecCapability, "stream">>;

/**
 * `snapshots` as authored: the provider writes only the primitives it genuinely
 * backs; {@link buildProvider} fills the common defaults so every provider
 * doesn't repeat the same stubs:
 *   - `createImageSnapshot`   → throws unsupported (registry-backed image
 *     snapshots are a Daytona-only concern)
 *   - `findSnapshot`          → falls back to `getSnapshot` (right for providers
 *     whose by-name lookup already tolerates an in-flight capture)
 *   - `removeInjectedSecrets` → no-op (most providers inject no secrets of
 *     their own; Vercel overrides it to remove its resume-context file)
 */
export type SnapshotDefinition = Omit<
  SnapshotCapability,
  "createImageSnapshot" | "findSnapshot" | "removeInjectedSecrets"
> &
  Partial<
    Pick<
      SnapshotCapability,
      "createImageSnapshot" | "findSnapshot" | "removeInjectedSecrets"
    >
  >;

/**
 * What a provider author writes: the metadata plus the capability namespaces,
 * matching {@link SandboxProvider} one-for-one. `sandbox` (create/delete) is
 * required; every other namespace is optional and defaults to `null`. The
 * client-safe `capabilities` flags are passed separately to {@link defineProvider}
 * (the client bundle reads them without importing a provider SDK), not embedded
 * here.
 */
export interface ProviderDefinition {
  name: SandboxProvider["name"];
  signedUrlTtlSeconds: number;

  /**
   * The user's home directory inside every sandbox this provider boots — a
   * per-provider constant (Amika controls the images), so the provisioning
   * layer reads it off the provider rather than querying a running sandbox.
   */
  userHomeDir: string;

  /**
   * Sandbox existence and run-state control. create/delete is the one
   * always-required surface; the run-state ops (start/stop/getState, and the
   * optional mapState whose default buildProvider fills) are present as a unit
   * on a lifecycle provider and all omitted on a create/delete-only one. See
   * {@link SandboxCapability}.
   */
  sandbox: SandboxCapability;

  /**
   * OPTIONAL provider-native git-clone override, surfaced as `Sandbox.git`.
   * Author it only when the provider's SDK has a first-class clone primitive
   * worth using over shell `git` (Daytona's native `git.clone`). Omit it on any
   * provider without one (Freestyle, Vercel) → `Sandbox.git` is `null` and the
   * provisioning layer clones by running `git` over the adapter exec port.
   * Decoupled from `capabilities.lifecycle`: a lifecycle provider need not
   * define it.
   */
  cloneRepo?: (
    providerSandboxId: string,
    input: CloneRepoInput,
  ) => Promise<void>;

  /**
   * OPTIONAL: persist what's needed to relaunch the sandbox's services after a
   * resume, surfaced as the nullable `Sandbox.persistServiceRestartContext`.
   * Author it ONLY on a provider whose suspended sandboxes come back with their
   * running processes gone (Vercel); every other provider omits it (→ `null`)
   * and never has to know the concept exists. See
   * {@link Sandbox.persistServiceRestartContext}.
   */
  persistServiceRestartContext?: (
    providerSandboxId: string,
    context: ServiceRestartContext,
  ) => Promise<void>;

  // Optional capability namespaces — omit (or pass null) when unsupported.
  exec?: ExecDefinition | null;
  files?: FileCapability | null;
  ssh?: SshCapability | null;
  services?: ServiceCapability | null;
  listing?: ListingCapability | null;
  snapshots?: SnapshotDefinition | null;
  dockerRegistries?: DockerRegistryCapability | null;
}

/**
 * Reconcile the SDK-free `capabilities` flags with what the definition actually
 * backs. The flags are authored in a separate, SDK-free module so the client
 * bundle can read them without instantiating a provider, which means they
 * *could* drift from the implementation — this is the single check that keeps
 * them honest, in both directions (a flag set with no namespace, or a namespace
 * with the flag unset, both throw).
 *
 * The namespace-internal invariants (files/services are method pairs, `stream`
 * requires `exec`) are gone from here — they're enforced by the definition's
 * types. `fullSnapshotCapture`/`skipStartScript` are behavioral sub-flags with
 * no namespace of their own, so they're carried through unchecked (the author
 * owns them).
 */
function assertCapabilitiesMatch(
  capabilities: SandboxProviderCapabilities,
  def: ProviderDefinition,
): void {
  // The sandbox run-state ops (start/stop/getState) are a unit — useless apart
  // — so they must be all present or all absent. Once flat on `sandbox` the
  // types no longer enforce this, so check it here.
  const runStateOps = [
    def.sandbox.start,
    def.sandbox.stop,
    def.sandbox.getState,
  ];
  const runStatePresent = runStateOps.filter((op) => op != null).length;
  if (runStatePresent !== 0 && runStatePresent !== runStateOps.length) {
    throw new Error(
      `Provider "${def.name}": sandbox run-state ops ` +
        `(start/stop/getState) must be all present or all absent`,
    );
  }

  // `lifecycle` gates the two things a provisioning run drives together — the
  // sandbox run-state ops and services (refreshUrls/syncRoutes) — so they must
  // be present as a unit or absent as a unit. (Cloning is no longer part of
  // this: `cloneRepo` is an optional provider-native override, surfaced as the
  // nullable `Sandbox.git`, and providers without it clone over adapter exec.)
  const lifecycleParts = {
    runState: def.sandbox.start != null,
    services: def.services != null,
  };
  const lifecycle = lifecycleParts.runState;
  if (Object.values(lifecycleParts).some((present) => present !== lifecycle)) {
    throw new Error(
      `Provider "${def.name}": lifecycle members must be enabled together, ` +
        `got ${JSON.stringify(lifecycleParts)}`,
    );
  }

  // Each flag derived from namespace presence; the behavioral sub-flags are
  // mirrored so they compare equal (the author owns them, nothing to derive).
  const derived: SandboxProviderCapabilities = {
    lifecycle,
    exec: def.exec != null,
    streaming: def.exec?.stream != null,
    ssh: def.ssh != null,
    services: def.services != null,
    listSandboxes: def.listing != null,
    snapshots: def.snapshots != null,
    // The scrub is core-synthesized over the exec primitive, so the flag is
    // the conjunction — a snapshots-without-exec provider offers only the raw
    // captures.
    scrubCapture: def.snapshots != null && def.exec != null,
    dockerRegistries: def.dockerRegistries != null,
    fullSnapshotCapture: capabilities.fullSnapshotCapture,
    skipStartScript: capabilities.skipStartScript,
    // Behavioral facts with no namespace to derive from — the author owns them.
    snapshotIdsAreOpaque: capabilities.snapshotIdsAreOpaque,
    supportsAutoDelete: capabilities.supportsAutoDelete,
  };

  for (const flag of Object.keys(derived) as Array<
    keyof SandboxProviderCapabilities
  >) {
    if (capabilities[flag] !== derived[flag]) {
      throw new Error(
        `Provider "${def.name}": declared capability "${flag}"=` +
          `${capabilities[flag]} but the definition ` +
          `${derived[flag] ? "provides" : "omits"} it`,
      );
    }
  }
}

/**
 * Assemble the full {@link SandboxProvider} from the definition, filling only
 * the contract-required gaps (the mapState/streaming defaults and the cloneRepo
 * stub). Every namespace the author omits becomes `null`.
 */
function buildProvider(
  capabilities: SandboxProviderCapabilities,
  def: ProviderDefinition,
): SandboxProvider {
  const { name } = def;

  // Optional provider-native clone override, surfaced as the nullable
  // `Sandbox.git`. `null` when omitted — the provisioning layer then clones
  // over the adapter exec port. No stub needed: cloning is not a core sandbox
  // capability, so there is no always-present clone method to satisfy.
  const cloneRepo = def.cloneRepo ?? null;
  // Optional resume-recovery seam, `null` unless the provider resets services
  // on resume (Vercel). Surfaced as `Sandbox.persistServiceRestartContext`.
  const persistServiceRestartContext = def.persistServiceRestartContext ?? null;
  // `mapState` has a safe default, so a lifecycle provider may omit it; fill it
  // in when the provider backs run-state control (i.e. authored `start`).
  const sandbox: SandboxCapability = def.sandbox.start
    ? { ...def.sandbox, mapState: def.sandbox.mapState ?? (() => "unknown") }
    : def.sandbox;
  // `streaming` is derived from `stream`'s presence, never authored.
  const exec: ExecCapability | null = def.exec
    ? {
        run: def.exec.run,
        stdin: def.exec.stdin,
        streaming: def.exec.stream != null,
        ...(def.exec.stream ? { stream: def.exec.stream } : {}),
      }
    : null;
  const files = def.files ?? null;
  const ssh = def.ssh ?? null;
  const services = def.services ?? null;
  const listing = def.listing ?? null;
  // Snapshot defaults (see {@link SnapshotDefinition}): unsupported image
  // snapshots, `find` falling back to `get`, and a no-op provider-secret
  // removal — authored only by the providers that genuinely differ.
  // NOTE: the spread copies OWN enumerable members only — author the snapshot
  // definition as an object literal (as every provider does), not a class
  // instance, whose prototype methods a spread would silently drop.
  const snapshots: SnapshotCapability | null = def.snapshots
    ? {
        ...def.snapshots,
        createImageSnapshot:
          def.snapshots.createImageSnapshot ??
          (() => {
            throw new SandboxProviderUnsupportedError(
              name,
              "createImageSnapshot",
            );
          }),
        findSnapshot:
          def.snapshots.findSnapshot ??
          def.snapshots.getSnapshot.bind(def.snapshots),
        removeInjectedSecrets:
          def.snapshots.removeInjectedSecrets ?? (() => Promise.resolve()),
      }
    : null;
  const dockerRegistries = def.dockerRegistries ?? null;

  // The resource-object surface is synthesized over the low-level
  // members above and closes over them, so it survives their later removal.
  const backend: ResourceBackend = {
    name,
    sandbox,
    exec,
    files,
    ssh,
    services,
    listing,
    snapshots,
    dockerRegistries,
    cloneRepo,
    persistServiceRestartContext,
  };

  return {
    name,
    capabilities,
    signedUrlTtlSeconds: def.signedUrlTtlSeconds,
    userHomeDir: def.userHomeDir,

    // Resource-object surface — the only consumer API. The authored
    // capability namespaces stay provider-side, reachable through the backend.
    sandboxes: makeSandboxNamespace(backend),
    snapshots: snapshots ? makeSnapshotNamespace(snapshots) : null,
    docker: dockerRegistries ? makeDockerNamespace(dockerRegistries) : null,
  };
}

/**
 * Define a sandbox provider. Takes the provider's client-safe capability flags
 * and a `define` callback, and returns a `(config) => SandboxProvider` factory
 * the registry invokes with the provider's config slice. `define` runs per
 * resolution, so config is captured by closure rather than stored on an
 * instance; the flags are reconciled against the definition on every build.
 */
export function defineProvider<Cfg>(
  capabilities: SandboxProviderCapabilities,
  define: (config: Cfg) => ProviderDefinition,
): (config: Cfg) => SandboxProvider {
  return (config: Cfg) => {
    const def = define(config);
    assertCapabilitiesMatch(capabilities, def);
    return buildProvider(capabilities, def);
  };
}
