/**
 * hostd's answers to `amika-net`'s two checks (spec 035,
 * `iroh-transport.md`, "Two checks on the host").
 *
 * - Check 1 (`check_peer`): is the caller's key a device or a service in
 *   the rules hostd holds?
 * - Check 2 (`open`): may the caller reach the target its stream names?
 *   The rules decide `not_allowed` and `port_not_allowed`. hostd then
 *   decides `unknown_rig` and `unreachable`, and answers with the loopback
 *   address to connect to.
 *
 * A rig target reaches a port as hostd's service routes do: the port the
 * rig's runtime publishes on the host's loopback (`MachineRuntime.hostPort`).
 * A port the rig does not publish is `unreachable`.
 *
 * The `hostd` target is answered by peer (`iroh-listeners.ts`): the
 * `dialer` service gets the preview listener, the `control_plane` service
 * gets hostd's API listener, and anyone else is `not_allowed`.
 *
 * The rules are checked before hostd looks the rig up, so a caller the
 * rules refuse learns nothing about which rigs exist.
 */
import {
  checkPeer as checkPeerInRules,
  checkTarget,
  parseTarget,
  type Principal,
  type RefusalReason,
  type RulesPayload,
} from "@amika/iroh-rules";
import type { RigOwners } from "./rig-owners.js";

/** The `check_peer` response, without its `id`. */
export type PeerAnswer =
  | { allowed: false }
  | { allowed: true; kind: "device"; principal: Principal }
  | { allowed: true; kind: "service"; service: string };

/** The `open` response, without its `id`. */
export type OpenAnswer =
  | { ok: true; connect: string }
  | { ok: false; reason: RefusalReason };

export interface IrohAccessDeps {
  /** The rules hostd holds now, or null before it has any. */
  rules: () => RulesPayload | null;
  owners: Pick<RigOwners, "get">;
  /** Whether a rig of this name is on this host. */
  rigExists: (rig: string) => Promise<boolean>;
  /** The loopback port a running rig publishes `port` on, or null. */
  hostPort: (rig: string, port: number) => Promise<number | null>;
  /** hostd's API listener, for the `control_plane` service. */
  apiPort: () => number | undefined;
  /**
   * The preview listener, for the `dialer` service, admitting the one
   * connection this answer leads to.
   */
  admitPreview: () => number | undefined;
}

export interface IrohAccess {
  checkPeer(endpointId: string): PeerAnswer;
  open(endpointId: string, target: string): Promise<OpenAnswer>;
}

export function irohAccess(deps: IrohAccessDeps): IrohAccess {
  return {
    checkPeer(endpointId) {
      const rules = deps.rules();
      if (rules === null) return { allowed: false };
      const peer = checkPeerInRules(rules, endpointId);
      if (!peer.allowed) return { allowed: false };
      return peer.kind === "device"
        ? { allowed: true, kind: "device", principal: peer.principal }
        : { allowed: true, kind: "service", service: peer.service.service };
    },
    async open(endpointId, text) {
      const rules = deps.rules();
      if (rules === null) return refuse("not_allowed");
      const peer = checkPeerInRules(rules, endpointId);
      if (!peer.allowed) return refuse("not_allowed");
      const target = parseTarget(text);
      if (target === null) return refuse("not_allowed");
      const owner =
        target.kind === "rig" ? deps.owners.get(target.rigId) : null;
      const decision = checkTarget(rules, peer, target, owner);
      if (!decision.allowed) return refuse(decision.reason);
      if (target.kind === "hostd") {
        if (peer.kind !== "service") return refuse("not_allowed");
        const port = hostdListener(peer.service.service);
        if (port === null) return refuse("not_allowed");
        return port === undefined ? refuse("unreachable") : connect(port);
      }
      if (!(await deps.rigExists(target.rigId))) return refuse("unknown_rig");
      const port = await deps.hostPort(target.rigId, target.port);
      return port === null ? refuse("unreachable") : connect(port);
    },
  };

  /** The listener `service` reaches; null for a service with none. */
  function hostdListener(service: string): number | undefined | null {
    switch (service) {
      case DIALER_SERVICE:
        return deps.admitPreview();
      case CONTROL_PLANE_SERVICE:
        return deps.apiPort();
      default:
        return null;
    }
  }
}

/** The services the rules name, as `iroh-contracts.md` spells them. */
const DIALER_SERVICE = "dialer";
const CONTROL_PLANE_SERVICE = "control_plane";

function refuse(reason: RefusalReason): OpenAnswer {
  return { ok: false, reason };
}

function connect(port: number): OpenAnswer {
  return { ok: true, connect: `127.0.0.1:${port}` };
}
