/**
 * Sandbox provider registry.
 *
 * The single place that maps a provider name to its implementation. Each entry
 * says how to build the provider from the caller-supplied deps and how to open
 * its {@link SandboxAdapter}; everything else about a provider lives in its own
 * folder. Adding a provider = adding one entry to {@link PROVIDERS} (see
 * `./README.md` for the full recipe).
 *
 * Provider construction takes an explicit {@link SandboxProviderDeps} (the
 * per-provider config slices plus the injected {@link SnapshotIdResolver}); the
 * caller supplies these, so this package carries no dependency on the caller's
 * data store. The config *slices* may be built from a documented env-var contract
 * via the opt-in `sandboxProviderConfigsFromEnv` (the one place this package
 * reads env-var names — see `../config-from-env`); provider construction itself
 * stays env-agnostic and takes the resolved slices.
 */
import type { DaytonaConfig } from "./daytona/config";
import type { E2bConfig } from "./e2b/config";
import type { FreestyleConfig } from "./freestyle/config";
import type { VercelConfig } from "./vercel/config";
import type { SandboxProvider, SnapshotIdResolver } from "./provider";
import { SandboxProviderUnsupportedError } from "./provider";
import type { SandboxProviderName } from "../types";
import type { SandboxAdapter } from "./shared/adapter";
import daytonaProvider from "./daytona/provider";
import e2bProvider, { openE2bAdapter } from "./e2b/provider";
import vercelProvider from "./vercel/provider";
import freestyleProvider from "./freestyle/provider";
import { openDaytonaAdapter } from "./daytona/provider";
import { openFreestyleAdapter } from "./freestyle/provider";
import { openVercelAdapter } from "./vercel/provider";

/**
 * Everything the registry needs to build any provider: the config slices (null
 * when a provider isn't configured in this environment) and the snapshot
 * name↔id resolver the opaque-id snapshot capabilities use.
 */
export interface SandboxProviderDeps {
  daytona: DaytonaConfig;
  e2b: E2bConfig | null;
  freestyle: FreestyleConfig | null;
  vercel: VercelConfig | null;
  /** Resolves an org-scoped snapshot name to its bootable opaque provider id. */
  resolveSnapshotId: SnapshotIdResolver;
}

/** How the registry builds one provider and opens its adapter. */
interface ProviderEntry {
  create(deps: SandboxProviderDeps): SandboxProvider;
  openAdapter(
    deps: SandboxProviderDeps,
    providerSandboxId: string,
  ): Promise<SandboxAdapter>;
}

/** Throw a config-hint error when a provider's config slice is absent. */
function requireConfig<T>(config: T | null, hint: string): T {
  if (!config) throw new Error(hint);
  return config;
}

const FREESTYLE_HINT =
  "Freestyle provider is not configured (set FREESTYLE_ENABLED=true and FREESTYLE_API_KEY)";
const VERCEL_HINT =
  "Vercel provider is not configured (set VERCEL_ENABLED=true and VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID)";
const E2B_HINT =
  "E2B provider is not configured (set E2B_ENABLED=true and E2B_API_KEY)";

/**
 * The provider table — the one registration point. A `null` entry keeps a
 * name in the {@link SandboxProviderName} union while resolving as
 * unsupported (none today). The `satisfies` keeps the table exhaustive:
 * adding a name to the union without an entry here fails to compile.
 */
const PROVIDERS = {
  daytona: {
    create: (deps) => daytonaProvider(deps.daytona),
    openAdapter: (deps, id) => openDaytonaAdapter(deps.daytona, id),
  },
  e2b: {
    create: (deps) =>
      e2bProvider({
        config: requireConfig(deps.e2b, E2B_HINT),
        resolveSnapshotId: deps.resolveSnapshotId,
      }),
    openAdapter: (deps, id) =>
      openE2bAdapter(requireConfig(deps.e2b, E2B_HINT), id),
  },
  freestyle: {
    create: (deps) =>
      freestyleProvider(requireConfig(deps.freestyle, FREESTYLE_HINT)),
    openAdapter: (deps, id) =>
      Promise.resolve(
        openFreestyleAdapter(requireConfig(deps.freestyle, FREESTYLE_HINT), id),
      ),
  },
  vercel: {
    // The Vercel snapshot capability resolves the org-scoped snapshot
    // name↔`snap_…` id mapping through the injected resolver (Vercel snapshots
    // are id-only) — without this package owning that mapping.
    // Daytona/Freestyle have their own by-name provider access and ignore it.
    create: (deps) =>
      vercelProvider({
        config: requireConfig(deps.vercel, VERCEL_HINT),
        resolveSnapshotId: deps.resolveSnapshotId,
      }),
    openAdapter: (deps, id) =>
      openVercelAdapter(requireConfig(deps.vercel, VERCEL_HINT), id),
  },
} satisfies Record<SandboxProviderName, ProviderEntry | null>;

export function isSandboxProviderName(
  name: string | null | undefined,
): name is SandboxProviderName {
  // `Object.hasOwn`, NOT `in`: `in` walks the prototype chain, so a garbage
  // name like "toString" or "constructor" would pass the guard and resolve an
  // inherited Object.prototype member instead of a provider entry.
  return name != null && Object.hasOwn(PROVIDERS, name);
}

/** The table entry for `name`, or null for unknown/unbacked names. */
function providerEntry(name: string | null): ProviderEntry | null {
  return isSandboxProviderName(name) ? PROVIDERS[name] : null;
}

/**
 * Build the provider for `name`. Throws {@link SandboxProviderUnsupportedError}
 * for an unknown/absent name and a plain error when the named provider is not
 * configured in this environment (e.g. freestyle/vercel without their
 * credentials).
 */
export function createSandboxProvider(
  name: string | null,
  deps: SandboxProviderDeps,
): SandboxProvider {
  const entry = providerEntry(name);
  if (!entry) {
    throw new SandboxProviderUnsupportedError(name ?? "unknown", "resolve");
  }
  return entry.create(deps);
}

/**
 * Open a fetched-once {@link SandboxAdapter} for a running sandbox.
 *
 * A provisioning run drives dozens of adapter ops against one running sandbox;
 * the `exec`/`files` capabilities re-fetch the provider handle per call (right
 * for a one-off op), so the caller opens the adapter once here and reuses it.
 * Dispatches like {@link createSandboxProvider}.
 */
export function getSandboxAdapter(
  name: string | null,
  deps: SandboxProviderDeps,
  providerSandboxId: string,
): Promise<SandboxAdapter> {
  const entry = providerEntry(name);
  if (!entry) {
    throw new SandboxProviderUnsupportedError(name ?? "unknown", "openAdapter");
  }
  return entry.openAdapter(deps, providerSandboxId);
}
