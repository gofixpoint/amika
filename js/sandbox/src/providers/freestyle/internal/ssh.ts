/**
 * Freestyle SSH access: mint and revoke SSH credentials for a VM.
 *
 * Freestyle has no Daytona-style server-side SSH session API. Instead SSH auth
 * rides on the identity/token system (docs.freestyle.sh/vms/ssh):
 *
 *   1. create an identity,
 *   2. grant that identity access to the VM,
 *   3. mint a token for the identity.
 *
 * You then connect as `ssh <vmId>+<user>:<token>@vm-ssh.freestyle.sh`. The token
 * is the SSH credential and lives inside the destination string.
 *
 * Two differences from Daytona shape this module:
 *
 *  - **No native expiry.** Freestyle tokens are valid until revoked, so the
 *    `expiresAt` we return is advisory (computed from the requested window). The
 *    credential is actually retired when the revoke endpoint runs — the
 *    `amika` CLI calls it on disconnect, the same way Freestyle's own `vm ssh`
 *    CLI revokes the token and deletes the identity when the session ends.
 *  - **Revoke needs ids, not the token string.** A token string can't be mapped
 *    back to its id (`tokens.list()` returns only ids), so revocation needs the
 *    `identityId` + `tokenId` learned at mint time. We carry those forward by
 *    encoding them into the opaque `token` field the SSH service round-trips to
 *    the revoke endpoint (see {@link MintedSshAccess}). That field is therefore
 *    a revocation handle, not the SSH secret — the secret only ever appears in
 *    `sshDestination`.
 */
import type { FreestyleConfig } from "../config";
import type { MintedSshAccess } from "../../provider";
import { withStepContext } from "../../../util/errorutils";
import { createFreestyleClient } from "./client";

/** Freestyle's SSH gateway host; auth is the token embedded in the username. */
const FREESTYLE_SSH_HOST = "vm-ssh.freestyle.sh";

/**
 * Linux user the SSH session lands as. Matches the unprivileged sandbox user the
 * Amika presets provision (see `adapter.ts`) so an SSH session sees the same
 * home, repos (`/home/amika/workspace`), and dotfiles as the agent — the
 * Freestyle analogue of Daytona logging in as its sandbox user. Doubles as the
 * sole `allowedUsers` entry on the VM grant, so a minted token can only log in
 * as this user.
 */
const FREESTYLE_SSH_USER = "amika";

interface FreestyleSshHandle {
  identityId: string;
  tokenId: string;
}

/**
 * Encode the revocation handle ({@link FreestyleSshHandle}) into the opaque
 * `token` string the SSH service returns to the client and later passes back to
 * revoke. base64url(JSON) keeps it a single URL/SSH-safe value and is robust to
 * whatever characters provider ids contain (a bare delimiter could collide).
 * This is NOT the SSH credential — the secret token lives only in
 * `sshDestination`.
 */
export function _encodeFreestyleSshHandle(handle: FreestyleSshHandle): string {
  const json = JSON.stringify({ v: 1, ...handle });
  return Buffer.from(json, "utf8").toString("base64url");
}

/** Inverse of {@link _encodeFreestyleSshHandle}; throws on a malformed handle. */
export function _decodeFreestyleSshHandle(encoded: string): FreestyleSshHandle {
  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Malformed Freestyle SSH revocation handle");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.identityId !== "string" ||
    typeof record.tokenId !== "string"
  ) {
    throw new Error("Malformed Freestyle SSH revocation handle");
  }
  return { identityId: record.identityId, tokenId: record.tokenId };
}

/**
 * Build the SSH destination (`[user@]host` — the parsed shape the SSH service
 * expects, mirroring Daytona's `_parseSshDestination`) for a VM and a freshly
 * minted token. Connecting as `vmId+user:token` logs in as
 * {@link FREESTYLE_SSH_USER} over Freestyle's gateway on the default port.
 * Exported for testing.
 */
export function _buildFreestyleSshDestination(
  vmId: string,
  token: string,
): string {
  return `${vmId}+${FREESTYLE_SSH_USER}:${token}@${FREESTYLE_SSH_HOST}`;
}

/**
 * Mint SSH access to a Freestyle VM: create an identity, grant it access to the
 * VM, and issue a token. Returns the connect destination (carrying the secret
 * token) plus an opaque revocation handle in `token` and an advisory `expiresAt`
 * derived from `expiresInMinutes` (Freestyle does not expire tokens itself).
 */
export async function createFreestyleSshAccess(
  config: FreestyleConfig,
  providerSandboxId: string,
  expiresInMinutes: number,
): Promise<MintedSshAccess> {
  const client = createFreestyleClient(config);
  // Each Freestyle call is wrapped so an opaque INTERNAL_ERROR identifies which
  // step failed (see `withStepContext`); the original SDK error and its trace id
  // are preserved as `cause`.
  const { identity, identityId } = await withStepContext(
    "freestyle ssh: create identity",
    () => client.identities.create(),
  );
  // Scope the grant to a single VM and a single Linux user: the identity (and
  // thus its token) can SSH only into this sandbox, and only as the
  // unprivileged `amika` user the destination connects as. This is the same
  // user the destination's `+amika` selects, kept on one constant so they can't
  // drift. Cross-sandbox isolation already holds from the org-scoped endpoint
  // lookup and the per-grant identity; `allowedUsers` adds least privilege
  // within the VM on top.
  await withStepContext("freestyle ssh: grant vm access", () =>
    identity.permissions.vms.grant({
      vmId: providerSandboxId,
      allowedUsers: [FREESTYLE_SSH_USER],
    }),
  );
  const { token, tokenId } = await withStepContext(
    "freestyle ssh: create token",
    () => identity.tokens.create(),
  );

  return {
    token: _encodeFreestyleSshHandle({ identityId, tokenId }),
    sshDestination: _buildFreestyleSshDestination(providerSandboxId, token),
    expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
  };
}

/**
 * Revoke SSH access previously minted by {@link createFreestyleSshAccess}. The
 * `handle` is the opaque value returned in `token`; it decodes to the identity
 * and token ids. Deleting the identity is the authoritative kill (it invalidates
 * every token under it), so the explicit token revoke is best-effort and a
 * stale/already-revoked token still tears the identity down.
 */
export async function revokeFreestyleSshAccess(
  config: FreestyleConfig,
  handle: string,
): Promise<void> {
  const { identityId, tokenId } = _decodeFreestyleSshHandle(handle);
  const client = createFreestyleClient(config);
  const identity = client.identities.ref({ identityId });
  try {
    await identity.tokens.revoke({ tokenId });
  } catch {
    // Ignore — deleting the identity below still removes access.
  }
  await client.identities.delete({ identityId });
}
