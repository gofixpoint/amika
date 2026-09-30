import { AmikaError } from "../errors.js";

/**
 * Inclusive lower bound of the container port range Amika reserves for its own
 * rig services.
 */
export const RESERVED_PORT_MIN = 60899;

/**
 * Inclusive upper bound of the reserved range (the OpenCode web UI runs on
 * 60998 and the amikad daemon on 60999). See `docs/sandbox-configuration.md`
 * for the full allocation table.
 */
export const RESERVED_PORT_MAX = 60999;

/**
 * Throw unless `port` is a legal, user-assignable container port: within
 * 1-65535 and outside the reserved Amika range. Mirrors Go's
 * `services.ValidatePort`, including its messages, so the same bad port fails
 * the same way whether it goes through the CLI or the SDK.
 *
 * The server enforces this too. Checking here turns a round trip into an
 * immediate error, which is the point of keeping the two in sync.
 */
export function validateServicePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AmikaError(`invalid port ${port}: must be between 1 and 65535`);
  }
  if (port >= RESERVED_PORT_MIN && port <= RESERVED_PORT_MAX) {
    throw new AmikaError(
      `invalid port ${port}: ports ${RESERVED_PORT_MIN}-${RESERVED_PORT_MAX} are reserved for internal Amika services`,
    );
  }
}
