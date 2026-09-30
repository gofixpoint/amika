import { type RemoteRig } from "../rigs/types.js";
import { AmikaError } from "../errors.js";

import { sleep } from "../internal/polling.js";
const WAIT_POLL_INTERVAL_MS = 3_000;
export async function waitForRigState(
  getRig: (name: string) => Promise<RemoteRig>,
  name: string,
  readyStates: readonly string[],
  failMsg: string,
): Promise<RemoteRig> {
  // Match Go: no client-side timeout, just poll until terminal state.
  for (;;) {
    const rig = await getRig(name);
    if (rig.state === "failed") {
      throw new AmikaError(rig.errorMessage || failMsg);
    }
    if (readyStates.includes(rig.state)) return rig;
    await sleep(WAIT_POLL_INTERVAL_MS);
  }
}
