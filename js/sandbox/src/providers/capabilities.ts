/**
 * Client-safe provider metadata: capability flags and display info.
 *
 * Pure data with no server or SDK imports, so client components can gate UI on
 * provider capabilities and render provider labels without hardcoding provider
 * names. This is the single source of truth for the capability flags — the
 * server-side provider implementations read from it too, so a provider's
 * capabilities are declared in exactly one place.
 */
import type {
  SandboxProviderCapabilities,
  SandboxProviderName,
} from "./provider";
import { daytonaCapabilities } from "./daytona/capabilities";
import { freestyleCapabilities } from "./freestyle/capabilities";
import { vercelCapabilities } from "./vercel/capabilities";

// Colocated pure constants (see each provider's `capabilities.ts`), aggregated
// here so the client-safe table stays the single source of truth without any
// provider SDK crossing into client bundles.
export const SANDBOX_PROVIDER_CAPABILITIES: Record<
  SandboxProviderName,
  SandboxProviderCapabilities
> = {
  daytona: daytonaCapabilities,
  freestyle: freestyleCapabilities,
  vercel: vercelCapabilities,
};

export interface SandboxProviderDisplay {
  /** Human label for the provider. */
  label: string;
  /** Tailwind classes for the provider badge. */
  badgeClassName: string;
}

export const SANDBOX_PROVIDER_DISPLAY: Record<
  SandboxProviderName,
  SandboxProviderDisplay
> = {
  daytona: { label: "Daytona", badgeClassName: "bg-gray-900 text-white" },
  freestyle: {
    label: "Freestyle",
    badgeClassName: "bg-purple-600 text-white",
  },
  vercel: {
    label: "Vercel",
    badgeClassName: "bg-black text-white",
  },
};

const UNKNOWN_BADGE_CLASS = "bg-gray-200 text-gray-700";

function isKnownProvider(
  name: string | null | undefined,
): name is SandboxProviderName {
  return name === "daytona" || name === "freestyle" || name === "vercel";
}

/** Capability flags for `name`, or null when the provider is unknown. */
export function getProviderCapabilities(
  name: string | null | undefined,
): SandboxProviderCapabilities | null {
  return isKnownProvider(name) ? SANDBOX_PROVIDER_CAPABILITIES[name] : null;
}

/** Display label for `name`, falling back to the raw name. */
export function getProviderLabel(name: string | null | undefined): string {
  return isKnownProvider(name)
    ? SANDBOX_PROVIDER_DISPLAY[name].label
    : (name ?? "Unknown");
}

/** Badge CSS classes for `name`. */
export function getProviderBadgeClassName(
  name: string | null | undefined,
): string {
  return isKnownProvider(name)
    ? SANDBOX_PROVIDER_DISPLAY[name].badgeClassName
    : UNKNOWN_BADGE_CLASS;
}

/**
 * Provider label for a sandbox, distinguishing a Daytona VM from a Daytona
 * container. `isVm` reflects whether the sandbox is VM-backed; for Daytona, a
 * non-true value (a container, or a sandbox created before VMs were tracked)
 * reads as "Container". Other providers fall back to the plain provider label.
 */
export function getSandboxProviderLabel(
  name: string | null | undefined,
  isVm: boolean | null | undefined,
): string {
  const label = getProviderLabel(name);
  if (name === "daytona") {
    return isVm ? `${label} VM` : `${label} Container`;
  }
  return label;
}
