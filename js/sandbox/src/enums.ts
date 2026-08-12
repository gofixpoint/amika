/**
 * Small provider-facing enums. The package owns the canonical value lists so
 * consumers can build their validation schemas from these and the literal sets
 * can't drift between the validation layer and the provider API.
 */

export const SANDBOX_PRESET_VALUES = ["coder", "coder-dind"] as const;
export type SandboxPreset = (typeof SANDBOX_PRESET_VALUES)[number];

export const SANDBOX_SIZE_VALUES = ["xs", "m", "l", "xl"] as const;
export type SandboxSize = (typeof SANDBOX_SIZE_VALUES)[number];

export const GITHUB_AUTH_MODE_VALUES = ["pat", "app_token"] as const;
export type GithubAuthMode = (typeof GITHUB_AUTH_MODE_VALUES)[number];
