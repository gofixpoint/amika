/**
 * Pure, provider-agnostic workspace-path helpers.
 *
 * Generic sandbox mechanics (where a repo lives on disk), used by the core
 * provider code (`cloneRepo`, the adapter configuration) and shared across
 * providers.
 */

export function getWorkspaceDir(homeDir: string): string {
  return `${homeDir}/workspace`;
}

export function getRepoDir(homeDir: string, repoName?: string | null): string {
  const workspaceDir = getWorkspaceDir(homeDir);
  return repoName ? `${workspaceDir}/${repoName}` : workspaceDir;
}
