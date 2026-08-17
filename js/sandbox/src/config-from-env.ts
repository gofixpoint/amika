/**
 * Build the per-provider config slices from environment variables.
 *
 * The single source of the sandbox provider ENV-VAR CONTRACT
 * (`DAYTONA_API_KEY`, `FREESTYLE_ENABLED`, `SAIL_API_KEY`,
 * `VERCEL_TOKEN`, …). The server
 * callers each used to hand-parse the identical set of vars into
 * `{ daytona, freestyle, sailbox, vercel }`;
 * they now share this so the credential/enable contract lives in one place and
 * the two can't drift.
 *
 * DELIBERATE EXCEPTION: unlike the rest of `@amika/sandbox` — which takes
 * explicit config and carries no dependency on the caller's environment — this
 * module reads specific env-var *names*. That's the trade for a single,
 * non-duplicated contract. It reads secrets (server-only) so it is NOT in the
 * browser-safe `./client` entry; but it is itself SDK-free (only type-only
 * config imports), so it is also exposed as its own `@amika/sandbox/config-env`
 * entry for server code that must stay SDK-free (e.g. modules reachable from the
 * Next middleware). Provider construction still takes explicit config via the
 * registry; this is an opt-in convenience for building it.
 */
import type { DaytonaConfig } from "./providers/daytona/config";
import type { FreestyleConfig } from "./providers/freestyle/config";
import type { SailboxConfig } from "./providers/sailbox/config";
import type { VercelConfig } from "./providers/vercel/config";

/** The three provider config slices a caller supplies to the registry. */
export interface SandboxProviderConfigs {
  daytona: DaytonaConfig;
  freestyle: FreestyleConfig | null;
  sailbox: SailboxConfig | null;
  vercel: VercelConfig | null;
}

type Env = Record<string, string | undefined>;

const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io/api";
const TRUE_TOKENS = new Set(["1", "true", "on"]);
const FALSE_TOKENS = new Set(["0", "false", "off"]);

/** Lenient env boolean: `1`/`true`/`on` → true, `0`/`false`/`off` → false. */
function parseBooleanLike(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  if (TRUE_TOKENS.has(normalized)) return true;
  if (FALSE_TOKENS.has(normalized)) return false;
  return false;
}

/** Strict enable flag: exactly `true` (case/space-insensitive) enables. */
function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalPositiveInt(env: Env, name: string): number | undefined {
  const value = env[name];
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Read the provider config slices from `env` (defaults to `process.env`).
 *
 * Daytona is always configured (the baseline provider). Freestyle/Vercel are
 * gated on `FREESTYLE_ENABLED` / `VERCEL_ENABLED` being exactly `true` and are
 * `null` otherwise. `ENABLE_DAYTONA_VM` and `ENABLE_DAYTONA_WEBSOCKET` (lenient
 * `1`/`true`/`on`) set `daytona.useVm` and `daytona.useWebSocket`;
 * `FREESTYLE_STAGING_SNAPSHOTS` toggles Freestyle's
 * `snapshotPersistence` between `sticky` and `persistent`. Throws if a required
 * credential for an enabled provider is missing.
 */
export function sandboxProviderConfigsFromEnv(
  env: Env = process.env,
): SandboxProviderConfigs {
  const daytona: DaytonaConfig = {
    apiKey: required(env, "DAYTONA_API_KEY"),
    apiUrl: env.DAYTONA_API_URL ?? DEFAULT_DAYTONA_API_URL,
    target: env.DAYTONA_TARGET,
    organizationId: env.DAYTONA_ORGANIZATION_ID,
    // Opt-in: run Daytona resources as VMs (`linux-vm`) rather than containers.
    useVm: parseBooleanLike(env.ENABLE_DAYTONA_VM),
    // Opt-in: observe sandbox state over the SDK's event stream (a persistent
    // WebSocket per client). Unset means polling, so no socket is opened.
    useWebSocket: parseBooleanLike(env.ENABLE_DAYTONA_WEBSOCKET),
  };

  const freestyle: FreestyleConfig | null = isEnabled(env.FREESTYLE_ENABLED)
    ? {
        apiKey: required(env, "FREESTYLE_API_KEY"),
        apiUrl: env.FREESTYLE_API_URL,
        snapshotPersistence: isEnabled(env.FREESTYLE_STAGING_SNAPSHOTS)
          ? "sticky"
          : "persistent",
      }
    : null;

  const vercel: VercelConfig | null = isEnabled(env.VERCEL_ENABLED)
    ? {
        apiKey: required(env, "VERCEL_TOKEN"),
        teamId: required(env, "VERCEL_TEAM_ID"),
        projectId: required(env, "VERCEL_PROJECT_ID"),
      }
    : null;

  const sailbox: SailboxConfig | null = isEnabled(env.SAILBOX_ENABLED)
    ? {
        apiKey: required(env, "SAIL_API_KEY"),
        apiUrl: env.SAIL_API_URL,
        sailboxApiUrl: env.SAILBOX_API_URL,
        appPrefix: env.SAILBOX_APP_PREFIX,
        checkpointTtlSeconds: optionalPositiveInt(
          env,
          "SAILBOX_CHECKPOINT_TTL_SECONDS",
        ),
      }
    : null;

  return { daytona, freestyle, sailbox, vercel };
}
