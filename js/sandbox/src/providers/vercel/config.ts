import type { SandboxConfigBase } from "../../config";

// Vercel Sandbox (Firecracker microVM) credentials. Access-token auth is used
// because amika runs off-Vercel (the recommended OIDC-token path only applies to
// code deployed on Vercel): the team-scoped access token is `apiKey`, plus the
// team and project the sandboxes are created under. New sandboxes always boot
// from a prepared snapshot; there is no runtime fallback, because a plain Vercel
// runtime lacks the baked-in amikad hooks and agent tooling an Amika sandbox
// needs.
export interface VercelConfig extends SandboxConfigBase {
  apiKey: string;
  teamId: string;
  projectId: string;
}

/**
 * The home / default working directory inside every Vercel sandbox — they run
 * as the `vercel-sandbox` user rooted at `/vercel/sandbox`. A per-provider
 * constant surfaced as `provider.userHomeDir` and used by the SSH mint path.
 */
export const VERCEL_HOME_DIR = "/vercel/sandbox";
