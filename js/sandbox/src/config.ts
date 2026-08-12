/**
 * Shared base shape for provider configuration slices.
 *
 * Owned by the provider package so it carries no dependency on the caller's
 * environment. Each provider defines its own config in its provider folder,
 * extending this base; the caller constructs the values and the provider
 * factory (`registry`) receives a single slice per provider.
 */

/**
 * The shape every provider config shares. `apiKey` is the provider's auth
 * secret (a Daytona/Freestyle API key, a Vercel access token); `apiUrl`
 * overrides the SDK's default API host (omitted uses the SDK default).
 * Providers that require one of these re-declare it as non-optional in their
 * own config interface.
 */
export interface SandboxConfigBase {
  apiKey?: string;
  apiUrl?: string;
}
