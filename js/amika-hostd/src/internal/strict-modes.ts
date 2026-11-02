/**
 * sshd's StrictModes, as amikad applies it when it sets up a bare-metal
 * host's sshd: every directory from amikad's state directory up to `/` must
 * be owned by root or the account sshd runs as, and writable by no one else.
 * Setup checks it, where the operator can fix it. Once a rig exists, the same
 * failure reaches the control plane only as an SSH bridge that did not come up.
 */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface PathOwner {
  uid: number;
  mode: number;
}

export interface StrictModesDeps {
  /** The account sshd runs as: the one running hostd. */
  uid: number;
  /** The owner and mode at `file`, or undefined when nothing is there. */
  stat?: (file: string) => PathOwner | undefined;
  realpath?: (file: string) => string;
}

export interface StrictModesViolation {
  dir: string;
  problem: "owner" | "writable";
  owner: PathOwner;
}

/**
 * The first directory above or at `dir` that StrictModes refuses, or
 * undefined. Directories not made yet are skipped: hostd creates them
 * private (0700) itself.
 */
export function strictModesViolation(
  dir: string,
  { uid, stat = statOrUndefined, realpath = realpathSync }: StrictModesDeps,
): StrictModesViolation | undefined {
  let current = path.resolve(dir);
  while (stat(current) === undefined) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  // sshd checks the resolved path, so a symlinked home is checked where it
  // really lives.
  current = realpath(current);
  for (;;) {
    const owner = stat(current);
    if (owner !== undefined) {
      if (owner.uid !== 0 && owner.uid !== uid) {
        return { dir: current, problem: "owner", owner };
      }
      if ((owner.mode & 0o022) !== 0) {
        return { dir: current, problem: "writable", owner };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Why setup refuses, and how to fix it, for `violation` above `stateDir`. */
export function describeStrictModesViolation(
  violation: StrictModesViolation,
  stateDir: string,
): string {
  const { dir, problem, owner } = violation;
  const why =
    problem === "writable"
      ? `${dir} is writable by its group or by everyone (mode ${(owner.mode & 0o777).toString(8)})`
      : `${dir} is owned by uid ${owner.uid}, not by you or root`;
  const fix =
    problem === "writable"
      ? `Run \`chmod go-w ${dir}\``
      : "Change its owner, or set XDG_STATE_HOME to a directory you own,";
  return `A bare-metal host's sshd will not start: ${why}. sshd's StrictModes requires every directory above amikad's state (${stateDir}) to be owned by you or root and writable by no one else. ${fix} and run \`amika-hostd setup\` again; nothing was changed.`;
}

function statOrUndefined(file: string): PathOwner | undefined {
  try {
    const { uid, mode } = statSync(file);
    return { uid, mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
