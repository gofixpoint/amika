/**
 * The rules record's types and schemas, as `iroh-contracts.md` ("The rules
 * record") fixes them. Wire types keep the wire's snake_case names.
 */
import { z } from "zod";
import { DEVICE_ID, ENDPOINT_ID, isPort, parseTarget } from "./ids";

/** The payload format this package reads and writes. */
export const RULES_FORMAT = 1;

/** The text that starts every signed message, before one zero byte. */
export const SIGNATURE_CONTEXT = "amika-iroh-rules-v1";

/** The signer kind Amika's control plane signs with. */
export const AMIKA_SIGNER_KIND = "amika";

/** A principal: someone who can be given access. Only `user` exists. */
export interface Principal {
  kind: "user";
  id: string;
}

/** A principal and the role the org gives it. */
export interface PrincipalRule extends Principal {
  role: string;
}

/** A device key, and the principal it belongs to. */
export interface DeviceRule {
  device_id: string;
  endpoint_id: string;
  principal: Principal;
}

/** Which rigs a role reaches: every rig, or rigs the principal owns. */
export type RigAccess = "all" | "own";

/** Which ports a role reaches on a rig it reaches. */
export type PortAccess = "all" | number[];

export interface RoleRule {
  rigs: RigAccess;
  ports: PortAccess;
}

/** An Amika service key, and the exact targets it may open. */
export interface ServiceRule {
  service: string;
  endpoint_id: string;
  targets: string[];
}

/** The signed payload: one org's rules at one version. */
export interface RulesPayload {
  format: number;
  required_features: string[];
  org_id: string;
  version: number;
  /** Milliseconds since the Unix epoch. */
  issued_at: number;
  principals: PrincipalRule[];
  devices: DeviceRule[];
  roles: Record<string, RoleRule>;
  services: ServiceRule[];
}

/** One signature in the envelope, and who made it. */
export interface RulesSignature {
  /** `amika` or `org`. A verifier refuses a kind it does not trust. */
  kind: string;
  /** The signing public key, as 64 lowercase hex characters. */
  key_id: string;
  principal?: Principal;
  device_id?: string;
  /** The 64-byte signature, as base64url with no padding. */
  sig: string;
}

/** What the control plane sends: the payload bytes as sent, and signatures. */
export interface RulesEnvelope {
  /** The payload bytes, as base64url with no padding. */
  payload: string;
  signatures: RulesSignature[];
}

const endpointIdSchema = z.string().regex(ENDPOINT_ID);

const principalSchema = z.object({
  kind: z.literal("user"),
  id: z.string().min(1),
});

const roleSchema = z.object({
  rigs: z.enum(["all", "own"]),
  ports: z.union([
    z.literal("all"),
    z.array(z.number().refine(isPort, "not a port")),
  ]),
});

/**
 * The payload's fields that decide whether this package can read the rest.
 * The verifier checks them before it applies `payloadSchema`.
 */
export const payloadHeaderSchema = z.object({
  format: z.number().int(),
});

export const requiredFeaturesSchema = z.object({
  required_features: z.array(z.string()),
});

/**
 * The format 1 payload. It drops fields it does not know. It refuses an
 * unknown value of a known field (a principal kind, a `rigs` or `ports`
 * value, a target), so a host never guesses what a new value means. A new
 * value comes with a required feature.
 */
export const payloadSchema: z.ZodType<RulesPayload> = z
  .object({
    format: z.literal(RULES_FORMAT),
    required_features: z.array(z.string()),
    org_id: z.string().min(1),
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    issued_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    principals: z.array(principalSchema.extend({ role: z.string().min(1) })),
    devices: z.array(
      z.object({
        device_id: z.string().regex(DEVICE_ID),
        endpoint_id: endpointIdSchema,
        principal: principalSchema,
      }),
    ),
    roles: z.record(z.string().min(1), roleSchema),
    services: z.array(
      z.object({
        service: z.string().min(1),
        endpoint_id: endpointIdSchema,
        targets: z.array(
          z.string().refine((t) => parseTarget(t) !== null, "not a target"),
        ),
      }),
    ),
  })
  .superRefine((payload, ctx) => {
    for (const message of duplicates(payload)) {
      ctx.addIssue({ code: "custom", message });
    }
  });

/**
 * Ids that must be unique. An endpoint id that is both a device and a
 * service, or two principals with one id, would make a check ambiguous.
 */
function duplicates(payload: RulesPayload): string[] {
  const found: string[] = [];
  const endpoints = new Set<string>();
  for (const { endpoint_id } of [...payload.devices, ...payload.services]) {
    if (endpoints.has(endpoint_id)) found.push(`endpoint ${endpoint_id}`);
    endpoints.add(endpoint_id);
  }
  const deviceIds = new Set<string>();
  for (const { device_id } of payload.devices) {
    if (deviceIds.has(device_id)) found.push(`device ${device_id}`);
    deviceIds.add(device_id);
  }
  const principals = new Set<string>();
  for (const principal of payload.principals) {
    const key = principalKey(principal);
    if (principals.has(key)) found.push(`principal ${key}`);
    principals.add(key);
  }
  return found.map((what) => `duplicate ${what}`);
}

/** A string that is equal for two principals exactly when they are. */
export function principalKey(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

export const signatureSchema = z.object({
  kind: z.string().min(1),
  key_id: endpointIdSchema,
  principal: principalSchema.optional(),
  device_id: z.string().regex(DEVICE_ID).optional(),
  sig: z.string(),
});

/**
 * The envelope. Each signature is checked against `signatureSchema` on its
 * own, so one signature in a shape this package does not know does not
 * spoil another that verifies.
 */
export const envelopeSchema = z.object({
  payload: z.string(),
  signatures: z.array(z.unknown()).min(1),
});
