/**
 * Small provider-facing enums. The package owns the canonical value lists so
 * consumers can build their validation schemas from these and the literal sets
 * can't drift between the validation layer and the provider API.
 */

export const GITHUB_AUTH_MODE_VALUES = ["pat", "app_token"] as const;
export type GithubAuthMode = (typeof GITHUB_AUTH_MODE_VALUES)[number];
