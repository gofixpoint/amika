/**
 * Git command builders + remote checks used by the provider provisioning flows:
 * ref validation, clone-URL construction, the checkout/remote command-string
 * builders, the in-place refresh script, a branch-existence probe, and
 * branch-not-found classification.
 */
import type { ExecResult } from "../providers/shared/adapter";
import { shellQuote } from "./shell";

// Reject shell metacharacters before building guest Git commands.
const SHELL_METACHAR_RE = /[;`$(){}|&><!"'#]/;

// Characters forbidden by `git check-ref-format` (rule 3): ASCII control
// chars, space, ~, ^, :, ?, *, [, ], \.
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const GIT_REF_FORBIDDEN_CHAR_RE = /[\x00-\x1f\x7f ~^:?*[\]\\]/;

const BRANCH_NOT_FOUND_RE = /fatal: Remote branch (.+) not found in upstream/;

/**
 * Validate a git branch / ref name. Enforces `git check-ref-format --branch`
 * rules plus rejects shell metacharacters and a leading `-` (argument
 * injection). Throws a descriptive error when the name is invalid.
 */
export function assertValidGitRef(ref: string): void {
  if (!ref) {
    throw new Error("Invalid git ref: name is empty");
  }
  if (ref.startsWith("-")) {
    throw new Error(
      `Invalid git ref: '${ref}' starts with '-' (argument injection)`,
    );
  }
  if (SHELL_METACHAR_RE.test(ref)) {
    throw new Error(`Invalid git ref: '${ref}' contains shell metacharacters`);
  }
  if (GIT_REF_FORBIDDEN_CHAR_RE.test(ref)) {
    throw new Error(
      `Invalid git ref: '${ref}' contains characters forbidden by git`,
    );
  }
  if (ref.includes("..")) {
    throw new Error(`Invalid git ref: '${ref}' contains '..'`);
  }
  if (ref.startsWith("/") || ref.endsWith("/") || ref.includes("//")) {
    throw new Error(`Invalid git ref: '${ref}' has invalid slash usage`);
  }
  if (ref.endsWith(".")) {
    throw new Error(`Invalid git ref: '${ref}' ends with '.'`);
  }
  if (ref.includes("@{")) {
    throw new Error(`Invalid git ref: '${ref}' contains '@{'`);
  }
  if (ref === "@") {
    throw new Error(`Invalid git ref: '${ref}' is the bare '@' character`);
  }
  for (const component of ref.split("/")) {
    if (!component) {
      throw new Error(`Invalid git ref: '${ref}' has an empty component`);
    }
    if (component.startsWith(".")) {
      throw new Error(
        `Invalid git ref: '${ref}' has a component starting with '.'`,
      );
    }
    if (component.endsWith(".lock")) {
      throw new Error(
        `Invalid git ref: '${ref}' has a component ending with '.lock'`,
      );
    }
  }
}

export function assertValidGitRemoteUrl(repoUrl: string): void {
  if (!repoUrl.trim()) {
    throw new Error("Invalid git remote URL: URL is empty");
  }
  if (repoUrl.startsWith("-")) {
    throw new Error(
      `Invalid git remote URL: '${repoUrl}' starts with '-' (argument injection)`,
    );
  }
  // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
  if (/[\x00-\x1f\x7f]/.test(repoUrl)) {
    throw new Error(
      `Invalid git remote URL: '${repoUrl}' contains control characters`,
    );
  }
}

/**
 * The clone URL, carrying an `x-access-token:<token>` credential **only when the
 * URL is github.com over https**.
 *
 * Both conditions matter, because git sends whatever is in a URL's userinfo to
 * whatever host the URL names, and a clone may `git remote set-url` the result
 * into `.git/config`:
 *
 *  - **the scheme**, or the credential travels in the clear;
 *  - **the host**, or a caller that takes a repository URL from untrusted input
 *    hands its GitHub credential to whatever host that URL named.
 *
 * The host check costs nothing: the token is a GitHub App installation token or
 * a PAT, so it is only ever meaningful to github.com. Anything else clones
 * anonymously — which works for a public repository and fails to authenticate
 * for a private one, the correct failure either way.
 *
 * Exported from the package barrel deliberately. Consumers that build their own
 * clone commands need this decision made in one place; without it they each grow
 * a near-copy, and the weakest one becomes reachable.
 */
export function buildCloneUrl(
  repoUrl: string,
  githubToken?: string | null,
): string {
  const credentials = getGithubCloneCredentials(repoUrl, githubToken);
  if (!credentials) return repoUrl;
  const url = new URL(repoUrl);
  url.username = credentials.username;
  url.password = credentials.password;
  return url.toString();
}

/** Return native Git credentials only for the same HTTPS GitHub target as URL clones. */
export function getGithubCloneCredentials(
  repoUrl: string,
  githubToken?: string | null,
): { username: string; password: string } | undefined {
  if (!githubToken) return undefined;
  // WHATWG treats backslashes as slashes, but native Git receives the raw URL:
  // https://github.com\@evil.example can therefore send credentials to evil.example.
  if (repoUrl.includes("\\")) return undefined;
  try {
    const url = new URL(repoUrl);
    if (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com"
    ) {
      return { username: "x-access-token", password: githubToken };
    }
  } catch {
    // SCP and other non-URL inputs must not receive a GitHub HTTP credential.
  }
  return undefined;
}

/**
 * Build a `git checkout -b <branch>` command string that is safe for shell
 * execution. Validates the branch name and uses `--` to prevent injection.
 */
export function buildGitCheckoutNewBranchCmd(branch: string): string {
  assertValidGitRef(branch);
  return `git checkout -b ${shellQuote(branch)} --`;
}

/**
 * Build a `git remote set-url origin <url>` command resetting the remote to a
 * plain (credential-free) URL. Used after `app_token`-mode clones so later
 * pushes consult the credential helper instead of an expired embedded token.
 */
export function buildGitSetPlainRemoteCmd(url: string): string {
  return `git remote set-url origin ${shellQuote(url)}`;
}

/**
 * Build a shell script that refreshes an already-cloned repository in place
 * (the fast path where the repo is baked into the booted snapshot). Re-points
 * `origin` at `cloneUrl`, restores the full-history refspec, fetches, then
 * checks out the same end state a fresh clone-with-branch-fallback would
 * produce. `branch` is validated; it and `cloneUrl` are shell-quoted.
 *
 * When `recurseSubmodules` is true (the default), the script also syncs and
 * checks out submodules after the branch checkout. `sync --recursive` is what
 * picks up a `.gitmodules` URL that changed between the snapshot's baked-in
 * commit and the one being checked out; `update --init` alone would keep using
 * the stale URL recorded in `.git/config`.
 */
export function buildRefreshClonedRepoScript(
  cloneUrl: string,
  branch?: string,
  recurseSubmodules: boolean = true,
): string {
  const quotedUrl = shellQuote(cloneUrl);
  const checkoutDefaultBranch = [
    "git remote set-head origin --auto >/dev/null 2>&1 || true",
    "def=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)",
    'def="${def#origin/}"',
    'if [ -z "$def" ]; then',
    "  def=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || true)",
    '  def="${def#origin/}"',
    "fi",
    'if [ -z "$def" ]; then echo "could not resolve origin default branch" >&2; exit 1; fi',
    'git checkout -f -B "$def" "origin/$def" --',
  ].join("\n");

  let checkout: string;
  if (branch) {
    assertValidGitRef(branch);
    checkout = [
      `if git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${branch}`)}; then`,
      `  git checkout -f -B ${shellQuote(branch)} ${shellQuote(`origin/${branch}`)} --`,
      "else",
      checkoutDefaultBranch.replace(/^/gm, "  "),
      `  ${buildGitCheckoutNewBranchCmd(branch)}`,
      "fi",
    ].join("\n");
  } else {
    checkout = checkoutDefaultBranch;
  }

  return [
    "set -e",
    `git remote set-url origin ${quotedUrl} 2>/dev/null || git remote add origin ${quotedUrl}`,
    "git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'",
    "git fetch --prune origin",
    checkout,
    ...(recurseSubmodules
      ? [
          "git submodule sync --recursive",
          "git submodule update --init --recursive",
        ]
      : []),
  ].join("\n");
}

function gitLsRemoteHeadsArgs(
  repoUrl: string,
  githubToken: string | null | undefined,
  branch: string,
): string[] {
  assertValidGitRemoteUrl(repoUrl);
  assertValidGitRef(branch);
  return [
    "ls-remote",
    "--heads",
    "--",
    buildCloneUrl(repoUrl, githubToken),
    `refs/heads/${branch}`,
  ];
}

/**
 * Check a remote branch through a required guest executor. Never starts a
 * host-side subprocess. On a network/auth error, returns `true` so the
 * caller treats existence as unknown and falls back to rethrowing the original
 * clone error rather than misreporting the branch as missing.
 */
export async function checkBranchExistsOnRemote(
  executeInGuest: (
    command: string,
  ) => Promise<Pick<ExecResult, "exitCode" | "stdout">>,
  repoUrl: string,
  githubToken: string | null | undefined,
  branch: string,
): Promise<boolean> {
  const args = gitLsRemoteHeadsArgs(repoUrl, githubToken, branch);
  try {
    const result = await executeInGuest(
      `git ${args.map(shellQuote).join(" ")}`,
    );
    return result.exitCode !== 0 || result.stdout.trim().length > 0;
  } catch {
    return true;
  }
}

/** Whether a git clone error is a "remote branch not found in upstream". */
export function isBranchNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return BRANCH_NOT_FOUND_RE.test(msg);
}
