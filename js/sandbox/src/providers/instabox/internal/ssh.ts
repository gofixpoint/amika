/**
 * SSH access through Instabox SSH tokens (https://instabox.sh/docs/api/ssh.md).
 *
 * A token is the SSH user name on the Instabox gateway:
 * `ssh -p 2222 ibssh_…@ssh.instabox.sh`. The gateway does not listen on port
 * 22, so `sshDestination` is an `ssh://` URI that carries the port
 * (`ssh://ibssh_…@ssh.instabox.sh:2222`); OpenSSH takes it as a destination.
 *
 * Revoke needs the token's id (`cn_…`), and the token cannot be mapped back
 * to it. So the `token` we return is that id: a revoke handle, not the
 * secret. The secret is only in `sshDestination`.
 */
import { z } from "zod";
import type { MintedSshAccess } from "../../provider";
import type { InstaboxConfig } from "../config";
import { isNotFound, machinePath, requestJson, requestVoid } from "./client";

/** Instabox token lifetime bounds, in seconds. */
const MIN_TTL_S = 60;
const MAX_TTL_S = 30 * 24 * 60 * 60;

const sshTokenSchema = z.object({
  id: z.string(),
  host: z.string(),
  port: z.number(),
  token: z.string(),
  expiresAt: z.string().nullish(),
});

/** The SSH destination for a token. Exported for tests. */
export function instaboxSshDestination(
  token: string,
  host: string,
  port: number,
): string {
  return port === 22 ? `${token}@${host}` : `ssh://${token}@${host}:${port}`;
}

export async function mintInstaboxSshAccess(
  config: InstaboxConfig,
  machineId: string,
  expiresInMinutes: number,
): Promise<MintedSshAccess> {
  const ttlSeconds = Math.min(
    Math.max(Math.round(expiresInMinutes * 60), MIN_TTL_S),
    MAX_TTL_S,
  );
  const minted = await requestJson(
    config,
    sshTokenSchema,
    "POST",
    machinePath(machineId, "/ssh-tokens"),
    // The key keeps a retry from making a second token.
    { idempotent: true, json: { name: "amika", ttlSeconds } },
  );
  return {
    token: minted.id,
    sshDestination: instaboxSshDestination(
      minted.token,
      minted.host,
      minted.port,
    ),
    expiresAt: minted.expiresAt
      ? new Date(minted.expiresAt)
      : new Date(Date.now() + ttlSeconds * 1000),
  };
}

/** Revoke a token by the id {@link mintInstaboxSshAccess} returned. */
export async function revokeInstaboxSshAccess(
  config: InstaboxConfig,
  machineId: string,
  tokenId: string,
): Promise<void> {
  try {
    await requestVoid(
      config,
      "DELETE",
      machinePath(machineId, `/ssh-tokens/${encodeURIComponent(tokenId)}`),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
