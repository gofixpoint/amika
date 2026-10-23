/**
 * Where this host attaches, and what it proves itself with.
 *
 * Two questions, answered from different places on purpose.
 *
 * **The credential** is host-scoped and opaque, and it lives in the same
 * secret store as hostd's other secrets. It is not the Amika API key, which
 * acts as the user across their whole organization and must never reach the
 * serving process; it is not the hostd secret key, which authorizes Amika's
 * requests *into* this daemon. Attaching a host is a third permission, worth
 * only this host's inbound traffic, so a copy of it is worth only that too.
 *
 * **The address** comes from the control plane, recorded here at enrolment.
 * The gateway for an environment is deployment configuration that Amika
 * owns: hosts move between staging and production, gateways move between
 * zones, and neither should mean editing a file on every operator's laptop.
 * A config or environment override exists above it, for a gateway running on
 * a developer's own machine and for pinning one host during an incident.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError, type HostdConfig } from "./config.js";
import type { Secrets } from "./credentials.js";
import { writePrivateFile } from "./private-file.js";
import type { TunnelTarget } from "./tunnel-dial.js";

/**
 * What enrolment recorded about this host's tunnel.
 *
 * The credential is **not** here. This file is read and written in the
 * ordinary course of running the daemon, and a record that also held the
 * credential would put it wherever the file was copied.
 */
export const tunnelEnrolmentSchema = z.strictObject({
  /** The durable Amika host id. Stable across reconnects and rotations. */
  host_id: z.string().min(1),
  /**
   * Which rotation of this host's credential the stored one is.
   *
   * Kept beside the credential so the daemon can refuse to dial with one it
   * has already replaced. The gateway learns the generation from the
   * control plane and never from the host, so this is not a claim: it is
   * the daemon's own record of how far it has got.
   */
  generation: z.number().int().min(0),
  /** The attachment endpoint the control plane assigned this host. */
  gateway_url: z.string().min(1),
  /** The public address Amika serves this host at, for the operator. */
  public_url: z.string().min(1).optional(),
});

export type TunnelEnrolmentFile = z.infer<typeof tunnelEnrolmentSchema>;

export interface TunnelEnrolment {
  hostId: string;
  generation: number;
  gatewayUrl: string;
  publicUrl?: string;
}

/** Where the record lives: beside the daemon's other state. */
export function tunnelEnrolmentPath(stateDir: string): string {
  return path.join(stateDir, "tunnel-enrolment.json");
}

/**
 * Read the record, or `undefined` when this host has never been enrolled
 * for tunnel mode.
 *
 * A file that is there but unreadable is an error and not an absence. A
 * daemon that treated a corrupt record as "not enrolled" would tell the
 * operator to enrol again, and enrolling again mints a new credential and
 * leaves the old one live until it is revoked.
 */
export function readTunnelEnrolment(
  file: string,
  readFile: (name: string) => string = (name) => readFileSync(name, "utf8"),
): TunnelEnrolment | undefined {
  let contents;
  try {
    contents = readFile(file);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new ConfigError(`Cannot read ${file}: ${errorCode(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new ConfigError(`${file} is not valid JSON`);
  }
  const parsed = tunnelEnrolmentSchema.safeParse(raw);
  if (!parsed.success) {
    // By field name, never by value: the record names a host and a gateway.
    const fields = parsed.error.issues.map((issue) =>
      issue.path.map(String).join("."),
    );
    throw new ConfigError(
      `${file} has invalid fields: ${[...new Set(fields)].join(", ")}`,
    );
  }
  return {
    hostId: parsed.data.host_id,
    generation: parsed.data.generation,
    gatewayUrl: parsed.data.gateway_url,
    publicUrl: parsed.data.public_url,
  };
}

/** Replace the record atomically, owner-readable only. */
export function writeTunnelEnrolment(
  file: string,
  enrolment: TunnelEnrolment,
  write: (name: string, contents: string) => void = writePrivateFile,
): void {
  const record: TunnelEnrolmentFile = {
    host_id: enrolment.hostId,
    generation: enrolment.generation,
    gateway_url: enrolment.gatewayUrl,
    ...(enrolment.publicUrl ? { public_url: enrolment.publicUrl } : {}),
  };
  write(file, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Everything one dial needs, or a message naming what the operator must do.
 *
 * Read again before every attempt, so a credential rotated while the daemon
 * runs is picked up on the next dial instead of at the next restart.
 */
export function resolveTunnelTarget(
  config: Pick<HostdConfig, "tunnelGatewayUrl">,
  secrets: Pick<Secrets, "attachmentCredential">,
  enrolment: TunnelEnrolment | undefined,
): TunnelTarget {
  if (!enrolment) {
    throw new ConfigError(
      'This host is not enrolled for tunnel mode. Run `amika-hostd setup` to enrol it, or set transport = "listen" to go back to a listening daemon.',
    );
  }
  const credential = secrets.attachmentCredential.get();
  if (credential === undefined || credential.trim() === "") {
    throw new ConfigError(
      `No tunnel attachment credential in ${secrets.attachmentCredential.description}. Run \`amika-hostd setup\` to enrol this host again.`,
    );
  }
  return {
    // The operator's override wins, for a gateway on a developer's machine
    // or a host pinned during an incident. Everything else uses what the
    // control plane assigned, so moving a gateway is one deployment change
    // and not a change on every host.
    gatewayUrl: config.tunnelGatewayUrl ?? enrolment.gatewayUrl,
    hostId: enrolment.hostId,
    credential,
    generation: enrolment.generation,
  };
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown error";
}
