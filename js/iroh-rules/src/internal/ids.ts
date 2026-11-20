/** Strict parsers for the ids and targets that cross the wire. */

/** A target named by a stream header: hostd's API, or a TCP port on a rig. */
export type Target =
  | { kind: "hostd" }
  | { kind: "rig"; rigId: string; port: number };

/**
 * Parse a stream header's target: `hostd` or `rig:<rig id>:<port>`.
 *
 * A rig id is hostd's machine name: a letter or digit, then letters,
 * digits, `_` and `-`, up to 128 characters. A port is a decimal number
 * from 1 to 65535 with no sign and no leading zero. Anything else,
 * including surrounding whitespace, returns `null`.
 */
export function parseTarget(text: string): Target | null {
  if (text === "hostd") return { kind: "hostd" };
  const match = RIG_TARGET.exec(text);
  if (match === null) return null;
  const port = Number(match[2]);
  if (port > MAX_PORT) return null;
  return { kind: "rig", rigId: match[1], port };
}

/** The text form of `target`, as `parseTarget` reads it. */
export function formatTarget(target: Target): string {
  return target.kind === "hostd"
    ? "hostd"
    : `rig:${target.rigId}:${target.port}`;
}

/**
 * Parse an endpoint id: an Ed25519 public key as 64 lowercase hex
 * characters, as iroh prints it. Returns `null` for any other text.
 */
export function parseEndpointId(text: string): string | null {
  return ENDPOINT_ID.test(text) ? text : null;
}

/** Whether `port` is a valid TCP port number. */
export function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT;
}

const MAX_PORT = 65_535;

const RIG_TARGET = /^rig:([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([1-9][0-9]{0,4})$/;

export const ENDPOINT_ID = /^[0-9a-f]{64}$/;

/** A device id: `dev_` and 26 letters or digits from the control plane. */
export const DEVICE_ID = /^dev_[0-9A-Za-z]{26}$/;
