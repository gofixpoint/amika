/**
 * GitHub URL helpers used by the provider layer.
 */
function trimGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

/** Extract the repo name from a `github.com` URL, or null if it isn't one. */
export function getRepoNameFromGithubUrl(githubUrl: string): string | null {
  try {
    const url = new URL(githubUrl);
    if (url.hostname !== "github.com") {
      return null;
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return trimGitSuffix(parts[1]);
  } catch {
    return null;
  }
}
