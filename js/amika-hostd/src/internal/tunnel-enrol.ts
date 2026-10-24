/**
 * Enrolling this host for tunnel mode.
 *
 * One call to the control plane, and two things written down from its
 * answer: the credential into the secret store, and everything else into
 * the enrolment record `tunnel-target.ts` reads.
 *
 * The split is that file's, and it matters. The record is read and written
 * in the ordinary course of running the daemon, so a record that also held
 * the credential would put the credential wherever the file was copied --
 * into a backup, a support bundle, a `scp` of the state directory.
 */
import {
  enrolHostTunnel,
  type AmikaApiConfig,
  type RegisteredHost,
} from "./amika-api.js";
import type { Secrets } from "./credentials.js";
import { writeTunnelEnrolment, type TunnelEnrolment } from "./tunnel-target.js";

export interface EnrolForTunnelDeps {
  enrol?: typeof enrolHostTunnel;
  write?: typeof writeTunnelEnrolment;
}

/**
 * Ask Amika to enrol this host, and record what it answers.
 *
 * The credential is stored before the record. Either order leaves a state
 * the daemon can explain and the operator can fix by running setup again,
 * but this one fails the better way: a credential with no record reads as
 * "not enrolled", which is true, where a record with no credential reads
 * as an enrolled host whose secret has gone missing, which is alarming and
 * wrong.
 *
 * Safe to run twice. The control plane answers with the credential it
 * already holds rather than minting a new one, so re-running setup does
 * not strand the credential the daemon is currently dialling with.
 */
export async function enrolForTunnel(
  api: AmikaApiConfig,
  host: Pick<RegisteredHost, "id">,
  secrets: Pick<Secrets, "attachmentCredential">,
  enrolmentFile: string,
  deps: EnrolForTunnelDeps = {},
  cancel?: AbortSignal,
): Promise<TunnelEnrolment> {
  const answer = await (deps.enrol ?? enrolHostTunnel)(
    api,
    host,
    undefined,
    cancel,
  );

  secrets.attachmentCredential.set(answer.credential);

  const enrolment: TunnelEnrolment = {
    hostId: host.id,
    generation: answer.generation,
    // From the control plane, not from this daemon's config. The gateway
    // for an environment is deployment configuration Amika owns; a config
    // override exists above this for a gateway on a developer's machine.
    gatewayUrl: answer.gateway_url,
  };
  (deps.write ?? writeTunnelEnrolment)(enrolmentFile, enrolment);
  return enrolment;
}
