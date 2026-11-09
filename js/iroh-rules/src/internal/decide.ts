/**
 * The host's two checks against verified rules. Pure functions: hostd owns
 * the rules it holds, the rig owners and the answer it sends `amika-net`.
 */
import { formatTarget, type Target } from "./ids";
import {
  principalKey,
  type DeviceRule,
  type Principal,
  type RulesPayload,
  type ServiceRule,
} from "./rules";

/** A peer that passed check 1. */
export type AllowedPeer =
  | { allowed: true; kind: "device"; device: DeviceRule; principal: Principal }
  | { allowed: true; kind: "service"; service: ServiceRule };

export type PeerCheck = AllowedPeer | { allowed: false };

/** The stream header's refusal reasons. */
export type RefusalReason =
  | "not_allowed"
  | "unknown_rig"
  | "port_not_allowed"
  | "unreachable";

/**
 * The result of check 2. The rules decide only `not_allowed` and
 * `port_not_allowed`. hostd decides `unknown_rig` and `unreachable`.
 */
export type TargetCheck =
  | { allowed: true }
  | { allowed: false; reason: "not_allowed" | "port_not_allowed" };

/**
 * Check 1: is `endpointId` a device or a service in the rules? A device
 * comes with the principal it belongs to.
 */
export function checkPeer(rules: RulesPayload, endpointId: string): PeerCheck {
  const device = rules.devices.find((d) => d.endpoint_id === endpointId);
  if (device !== undefined) {
    return {
      allowed: true,
      kind: "device",
      device,
      principal: device.principal,
    };
  }
  const service = rules.services.find((s) => s.endpoint_id === endpointId);
  if (service !== undefined) return { allowed: true, kind: "service", service };
  return { allowed: false };
}

/**
 * Check 2: may `peer` open `target`?
 *
 * - A service opens only the targets listed for it.
 * - A device opens only rig targets, by its principal's role: `all` rigs,
 *   or `own` rigs, whose owner is the principal. A rig with no owner
 *   (`rigOwner` null) matches only `all`. Then the role's ports apply.
 *
 * `peer` must come from `checkPeer` on the same `rules`: the device's
 * principal and the service are looked up in them again.
 */
export function checkTarget(
  rules: RulesPayload,
  peer: AllowedPeer,
  target: Target,
  rigOwner: Principal | null,
): TargetCheck {
  switch (peer.kind) {
    case "service":
      return checkServiceTarget(rules, peer.service, target);
    case "device":
      return checkDeviceTarget(rules, peer.principal, target, rigOwner);
    default:
      return assertNever(peer);
  }
}

const NOT_ALLOWED: TargetCheck = { allowed: false, reason: "not_allowed" };

function checkServiceTarget(
  rules: RulesPayload,
  service: ServiceRule,
  target: Target,
): TargetCheck {
  const current = rules.services.find(
    (s) => s.endpoint_id === service.endpoint_id,
  );
  if (current === undefined) return NOT_ALLOWED;
  return current.targets.includes(formatTarget(target))
    ? { allowed: true }
    : NOT_ALLOWED;
}

function checkDeviceTarget(
  rules: RulesPayload,
  principal: Principal,
  target: Target,
  rigOwner: Principal | null,
): TargetCheck {
  if (target.kind !== "rig") return NOT_ALLOWED;
  const role = roleOf(rules, principal);
  if (role === undefined) return NOT_ALLOWED;
  const ownsRig =
    rigOwner !== null && principalKey(rigOwner) === principalKey(principal);
  if (role.rigs === "own" && !ownsRig) return NOT_ALLOWED;
  if (role.ports !== "all" && !role.ports.includes(target.port)) {
    return { allowed: false, reason: "port_not_allowed" };
  }
  return { allowed: true };
}

/** The principal's role rule, or undefined when it has none. */
export function roleOf(rules: RulesPayload, principal: Principal) {
  const key = principalKey(principal);
  const entry = rules.principals.find((p) => principalKey(p) === key);
  if (entry === undefined || !Object.hasOwn(rules.roles, entry.role)) {
    return undefined;
  }
  return rules.roles[entry.role];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
