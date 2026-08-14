/**
 * Resource-object factories.
 *
 * Synthesizes the consumer-facing {@link Sandbox} / {@link Snapshot} /
 * {@link DockerRegistry} objects over a provider's low-level capability
 * namespaces. The factories close over the *authored* capability objects (the
 * {@link ResourceBackend} passed by {@link buildProvider}), not over public
 * provider keys, so later removing a flat member from the contract never disturbs
 * the object wiring.
 *
 * Providers write no code here: a provider declares its primitives via
 * `defineProvider` and gains the resource surface for free. Gating mirrors the flat
 * surface — an operation whose backing capability is absent throws {@link
 * SandboxProviderUnsupportedError}, and the `ssh`/`services`/`snapshots`
 * sub-namespaces are `null` when the provider doesn't back them.
 */
import { SandboxProviderUnsupportedError } from "../provider";
import { scrubTargetsViaExec } from "./scrub-exec";
import type {
  CloneRepoInput,
  DockerNamespace,
  DockerRegistry,
  DockerRegistryCapability,
  ExecCapability,
  FileCapability,
  ListingCapability,
  ProviderDockerRegistry,
  ProviderSnapshot,
  Sandbox,
  SandboxCapability,
  SandboxGitNamespace,
  SandboxNamespace,
  ServiceRestartContext,
  LoadedServices,
  SandboxServiceNamespace,
  SandboxSnapshotNamespace,
  SandboxSshNamespace,
  Service,
  ServiceCapability,
  Snapshot,
  SnapshotCapability,
  SnapshotNamespace,
  SshCapability,
} from "../provider";
import type { SandboxProviderName, SandboxService } from "../../types";

/**
 * The authored low-level capabilities the resource layer delegates to — the
 * subset of a built provider the resource objects need. Assembled by
 * {@link buildProvider} from the provider definition.
 */
export interface ResourceBackend {
  name: SandboxProviderName;
  sandbox: SandboxCapability;
  exec: ExecCapability | null;
  files: FileCapability | null;
  ssh: SshCapability | null;
  services: ServiceCapability | null;
  listing: ListingCapability | null;
  snapshots: SnapshotCapability | null;
  dockerRegistries: DockerRegistryCapability | null;
  /**
   * Optional provider-native clone primitive. `null` when the provider has no
   * first-class clone (Freestyle, Vercel) — the provisioning layer clones those
   * over the adapter exec port instead, so `Sandbox.git` is `null` for them.
   */
  cloneRepo:
    | ((providerSandboxId: string, input: CloneRepoInput) => Promise<void>)
    | null;
  /**
   * Optional per-provider "persist what's needed to relaunch services on resume"
   * primitive. `null` unless the provider's suspended sandboxes lose their
   * running processes (Vercel); surfaced as the nullable
   * `Sandbox.persistServiceRestartContext`.
   */
  persistServiceRestartContext:
    | ((
        providerSandboxId: string,
        context: ServiceRestartContext,
      ) => Promise<void>)
    | null;
}

/** Build the top-level `sandboxes` namespace from a backend. */
export function makeSandboxNamespace(
  backend: ResourceBackend,
): SandboxNamespace {
  const get = (providerSandboxId: string): Sandbox =>
    makeSandbox(backend, providerSandboxId);
  return {
    async create(ctx, input) {
      const created = await backend.sandbox.create(ctx, input);
      return makeSandbox(backend, created.providerSandboxId, created);
    },
    get,
    async list() {
      if (!backend.listing) {
        throw new SandboxProviderUnsupportedError(backend.name, "list");
      }
      return backend.listing.list();
    },
  };
}

/**
 * Build the top-level `snapshots` namespace over the authored capability.
 * `get`/`find`/`createImage` preserve the capability's null contract (missing /
 * still-registering / name-already-exists → `null`) and wrap a hit in a
 * {@link Snapshot} whose bound ops carry the provider handle. Names are built
 * by the caller's own naming helpers — naming is Amika policy, not provider
 * mechanics.
 */
export function makeSnapshotNamespace(
  snapshots: SnapshotCapability,
): SnapshotNamespace {
  const wrap = (data: ProviderSnapshot | null): Snapshot | null =>
    data ? makeSnapshot(snapshots, data) : null;
  return {
    async get(name) {
      return wrap(await snapshots.getSnapshot(name));
    },
    async find(name) {
      return wrap(await snapshots.findSnapshot(name));
    },
    async createImage(input) {
      return wrap(await snapshots.createImageSnapshot(input));
    },
  };
}

/** Build the top-level `docker` namespace, or return null when unsupported. */
export function makeDockerNamespace(
  registries: DockerRegistryCapability,
): DockerNamespace {
  return {
    registries: {
      async create(input) {
        return makeDockerRegistry(
          registries,
          await registries.createRegistry(input),
        );
      },
      async list() {
        const all = await registries.listRegistries();
        return all.map((r) => makeDockerRegistry(registries, r));
      },
      async get(registryId) {
        return makeDockerRegistry(
          registries,
          await registries.getRegistry(registryId),
        );
      },
    },
  };
}

/** The sandbox run-state ops, narrowed to non-optional (present as a unit). */
type SandboxRunState = Required<
  Pick<SandboxCapability, "start" | "stop" | "getState" | "mapState">
>;

function makeSandbox(
  backend: ResourceBackend,
  id: string,
  created?: Sandbox["created"],
): Sandbox {
  // The run-state ops live flat on `sandbox` and are present as a unit; narrow
  // them to a non-optional bundle or throw when the provider omits them.
  const requireRunState = (op: string): SandboxRunState => {
    const { start, stop, getState, mapState } = backend.sandbox;
    if (!start || !stop || !getState || !mapState) {
      throw new SandboxProviderUnsupportedError(backend.name, op);
    }
    return { start, stop, getState, mapState };
  };
  const requireExec = (op: string): ExecCapability => {
    if (!backend.exec) {
      throw new SandboxProviderUnsupportedError(backend.name, op);
    }
    return backend.exec;
  };
  const requireFiles = (op: string): FileCapability => {
    if (!backend.files) {
      throw new SandboxProviderUnsupportedError(backend.name, op);
    }
    return backend.files;
  };

  // Methods are `async` so an unsupported-capability throw surfaces as a
  // rejected promise (uniform with the ops that do real I/O), never a
  // synchronous throw a `.catch()` chain would miss.
  return {
    id,
    provider: backend.name,
    created,
    start: async (autoStopInterval) =>
      requireRunState("start").start(id, autoStopInterval),
    stop: async () => requireRunState("stop").stop(id),
    delete: async () => backend.sandbox.delete(id),
    getState: async () => requireRunState("getState").getState(id),
    mapState: (rawState) => requireRunState("mapState").mapState(rawState),
    async getRuntimeState() {
      const runState = requireRunState("getRuntimeState");
      return runState.mapState(await runState.getState(id));
    },
    exec: async (command, opts) => requireExec("exec").run(id, command, opts),
    async streamExec(command, handlers) {
      const exec = requireExec("streamExec");
      if (!exec.stream) {
        throw new SandboxProviderUnsupportedError(backend.name, "streamExec");
      }
      return exec.stream(id, command, handlers);
    },
    readFile: async (filePath) => requireFiles("readFile").read(id, filePath),
    writeFile: async (filePath, content) =>
      requireFiles("writeFile").write(id, filePath, content),
    git: backend.cloneRepo ? makeSandboxGit(backend.cloneRepo, id) : null,
    persistServiceRestartContext: backend.persistServiceRestartContext
      ? (context) => backend.persistServiceRestartContext!(id, context)
      : null,
    ssh: backend.ssh ? makeSandboxSsh(backend.ssh, id) : null,
    services: backend.services
      ? makeSandboxServices(backend.services, id)
      : null,
    snapshots: backend.snapshots
      ? makeSandboxSnapshots(backend, backend.snapshots, id)
      : null,
  };
}

function makeSandboxGit(
  cloneRepo: (
    providerSandboxId: string,
    input: CloneRepoInput,
  ) => Promise<void>,
  id: string,
): SandboxGitNamespace {
  return { clone: (input) => cloneRepo(id, input) };
}

function makeSandboxSsh(ssh: SshCapability, id: string): SandboxSshNamespace {
  return {
    async mint(expiresInMinutes, services) {
      const access = await ssh.mint(id, expiresInMinutes, services);
      return { ...access, revoke: () => ssh.revoke(id, access.token) };
    },
    revoke: (token) => ssh.revoke(id, token),
  };
}

function makeSandboxServices(
  services: ServiceCapability,
  id: string,
): SandboxServiceNamespace {
  return {
    refreshAll: (svcs) => services.refreshUrls(id, svcs),
    load: (svcs) => makeLoadedServices(services, id, svcs),
  };
}

/**
 * Object-ify a point-in-time service set over the
 * declarative `syncRoutes` primitive. Each {@link Service}'s mutation derives
 * the desired set from the loaded snapshot — revoke is "the set minus me",
 * update is "the set with `next` in my place" — so no caller hand-computes a
 * removed/remaining split. Identity is positional (not port equality), so a
 * legacy set carrying two services on one port revokes exactly the loaded
 * entry, and the shared port survives while the other still claims it.
 */
function makeLoadedServices(
  services: ServiceCapability,
  providerSandboxId: string,
  serviceList: SandboxService[],
): LoadedServices {
  const loadedServices = [...serviceList];
  const makeService = (svc: SandboxService, index: number): Service => ({
    ...svc,
    revoke: () =>
      services.syncRoutes(
        providerSandboxId,
        loadedServices.filter((_, i) => i !== index),
      ),
    async update(next) {
      const replaced = loadedServices.map((s, i) => (i === index ? next : s));
      await services.syncRoutes(providerSandboxId, replaced);
      return services.refreshUrls(providerSandboxId, replaced);
    },
  });
  return {
    list: () => loadedServices.map(makeService),
    get(containerPort) {
      const index = loadedServices.findIndex(
        (s) => s.containerPort === containerPort,
      );
      return index === -1 ? null : makeService(loadedServices[index]!, index);
    },
    async refresh() {
      await services.syncRoutes(providerSandboxId, loadedServices);
      return services.refreshUrls(providerSandboxId, loadedServices);
    },
  };
}

function makeSandboxSnapshots(
  backend: ResourceBackend,
  snapshots: SnapshotCapability,
  id: string,
): SandboxSnapshotNamespace {
  return {
    async create(snapshotName) {
      const captured = await snapshots.capture(id, snapshotName, {
        keepSourceRunning: true,
      });
      return makeSnapshot(snapshots, {
        name: snapshotName,
        providerSnapshotId: captured.providerSnapshotId,
      });
    },
    // The destructive scrub-and-capture, synthesized here rather than
    // implemented per provider: scrub the Amika-computed targets
    // through the exec primitive (fail-closed verification, bare resume so a
    // stopped Vercel sandbox can't relaunch services with the secret being
    // scrubbed), have the provider remove its own injected secrets, then
    // capture with delete-intent. Requires exec — `snapshots` and `exec` are
    // independently declarable, so the op gates on both (mirrored by the
    // client-safe `capabilities.scrubCapture` flag).
    async scrubAndCreate(snapshotName, targets) {
      if (!backend.exec) {
        throw new SandboxProviderUnsupportedError(
          backend.name,
          "scrubAndCreate",
        );
      }
      await scrubTargetsViaExec(backend.exec, id, targets);
      await snapshots.removeInjectedSecrets(id);
      const captured = await snapshots.capture(id, snapshotName, {
        keepSourceRunning: false,
      });
      return {
        removedFiles: targets.files,
        removedEnvVars: targets.envVarNames,
        snapshot: makeSnapshot(snapshots, {
          name: snapshotName,
          providerSnapshotId: captured.providerSnapshotId,
        }),
      };
    },
    isEnvScrubbable: () => snapshots.isEnvScrubbable(id),
  };
}

function makeSnapshot(
  snapshots: SnapshotCapability,
  data: ProviderSnapshot,
): Snapshot {
  // Pass the known bootable handle alongside the name: an id-only provider
  // (Vercel) uses it directly, so a freshly captured Snapshot is operable
  // before the name↔id mapping has been recorded.
  return {
    ...data,
    async waitForActive() {
      return makeSnapshot(
        snapshots,
        await snapshots.waitForSnapshotActive(
          data.name,
          data.providerSnapshotId,
        ),
      );
    },
    delete: () => snapshots.deleteSnapshot(data.name, data.providerSnapshotId),
  };
}

function makeDockerRegistry(
  registries: DockerRegistryCapability,
  data: ProviderDockerRegistry,
): DockerRegistry {
  return { ...data, delete: () => registries.deleteRegistry(data.id) };
}
