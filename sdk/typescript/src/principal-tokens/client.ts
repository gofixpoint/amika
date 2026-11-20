import { AmikaError } from "../errors.js";
import { type HTTPClient } from "../internal/http.js";
import { API_BASE_PATH } from "../internal/constants.js";
import { omitUndefined, str } from "../internal/wire.js";
import { type PrincipalToken, type PrincipalTokens } from "./types.js";

export function createPrincipalTokens(http: HTTPClient): PrincipalTokens {
  const base = `${API_BASE_PATH}/iam/principal-tokens`;
  return {
    mint: async (request) => {
      const wire = await http.doJSON<Record<string, unknown>>(
        "POST",
        base,
        omitUndefined({
          principal: request.principal,
          ttl_seconds: request.ttlSeconds,
        }),
      );
      return principalTokenFromWire(wire ?? {});
    },
    revoke: async (id) => {
      if (id.trim().length === 0) {
        throw new AmikaError("principalTokens.revoke: id must be non-empty");
      }
      await http.doJSON("DELETE", `${base}/${encodeURIComponent(id)}`);
    },
  };
}

function principalTokenFromWire(wire: Record<string, unknown>): PrincipalToken {
  return {
    id: str(wire.id),
    token: str(wire.token),
    expiresAt: str(wire.expires_at),
  };
}
